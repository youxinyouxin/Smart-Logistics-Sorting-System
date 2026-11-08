import { ApiError } from './api'

export const DEFAULT_SORTER_API_BASE = '/sorter'

const REQUEST_TIMEOUT_MS = 8000

export interface SorterRecord {
  pid: number
  time: string
  timestamp: number
  province: string
  category: string
  servo: string
  result: string
  ocr_calls: number
  file: string
}

export interface SorterRecordsResponse {
  count: number
  records: SorterRecord[]
}

export function normalizeSorterBase(input: string): string {
  const raw = (input || '').trim().replace(/\/+$/, '')
  if (!raw) return DEFAULT_SORTER_API_BASE
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/')) return `http://${raw}`
  return raw
}

function sorterUrl(base: string, path: string): string {
  return `${normalizeSorterBase(base)}${path.startsWith('/') ? path : `/${path}`}`
}

async function requestSorterText(
  base: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort('external')
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(sorterUrl(base, path), {
      method: 'GET',
      headers: { Accept: 'text/plain, application/json' },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new ApiError('http', `分拣接口返回 ${response.status}`, response.status, text.slice(0, 200))
    }
    return text
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (String(controller.signal.reason ?? '') === 'timeout') {
        throw new ApiError('timeout', '分拣服务请求超时')
      }
      throw new ApiError('aborted', '请求已取消')
    }
    throw new ApiError('network', '无法连接分拣服务')
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function getSorterRecords(
  base: string,
  limit = 500,
  signal?: AbortSignal,
): Promise<SorterRecordsResponse> {
  const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)))
  const text = await requestSorterText(base, `/records?limit=${safeLimit}`, signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError('parse', '分拣记录返回格式不正确')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('parse', '分拣记录返回格式不正确')
  }
  const record = parsed as Record<string, unknown>
  const recordsRaw = Array.isArray(record.records) ? record.records : []
  const records: SorterRecord[] = recordsRaw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      pid: Number.isFinite(Number(item.pid)) ? Number(item.pid) : 0,
      time: typeof item.time === 'string' ? item.time : '',
      timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : 0,
      province: typeof item.province === 'string' ? item.province : '',
      category: typeof item.category === 'string' ? item.category : '',
      servo: typeof item.servo === 'string' ? item.servo : '',
      result: typeof item.result === 'string' ? item.result : '',
      ocr_calls: Number.isFinite(Number(item.ocr_calls)) ? Number(item.ocr_calls) : 0,
      file: typeof item._file === 'string' ? item._file : '',
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
  return {
    count: Number.isFinite(Number(record.count)) ? Number(record.count) : records.length,
    records,
  }
}

export async function getSorterLogs(
  base: string,
  lines = 200,
  signal?: AbortSignal,
): Promise<string> {
  const safeLines = Math.min(5000, Math.max(1, Math.floor(lines)))
  return requestSorterText(base, `/logs?lines=${safeLines}`, signal)
}
