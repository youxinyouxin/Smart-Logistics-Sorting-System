import { useEffect, useState } from 'react'
import { PackageOpen, RefreshCw } from 'lucide-react'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { errorMessage } from '../../lib/api'
import { getSorterRecords } from '../../lib/sorterApi'
import { useSettings } from '../../lib/settings'
import type { SorterRecord } from '../../lib/sorterApi'

const FETCH_LIMIT = 500
const PAGE_SIZE = 20

function categoryTone(category: string): 'ok' | 'warn' | 'brand' | 'neutral' {
  if (category === '省内') return 'ok'
  if (category === '货运') return 'warn'
  if (category === '空运') return 'brand'
  return 'neutral'
}

export function ParcelRecordsPanel() {
  const { settings } = useSettings()
  const base = settings.sorterApiBaseUrl
  const [records, setRecords] = useState<SorterRecord[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getSorterRecords(base, FETCH_LIMIT, controller.signal)
      .then((response) => {
        if (cancelled) return
        setRecords(response.records)
      })
      .catch((caught) => {
        if (cancelled) return
        const message = errorMessage(caught)
        if (message !== '请求已取消') setError(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [base, refreshNonce])

  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const startRow = records.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1
  const endRow = Math.min(currentPage * PAGE_SIZE, records.length)
  const rows = records.slice((currentPage - 1) * PAGE_SIZE, endRow)

  const refresh = () => {
    setPage(1)
    setRefreshNonce((value) => value + 1)
  }

  return (
    <section className="panel ops-panel" role="tabpanel" aria-label="快递记录">
      <div className="parcel-head">
        <div>
          <div className="section-head__title">分拣完成记录</div>
          <div className="ops-panel__hint">
            <PackageOpen size={16} aria-hidden="true" /> 最近最多 {FETCH_LIMIT} 条 · 按完成时间倒序
          </div>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={18} aria-hidden="true" />}
          loading={loading}
          onClick={refresh}
        >
          刷新
        </Button>
      </div>

      {error ? (
        <div className="ops-error" role="alert">
          <strong>快递记录读取失败</strong>
          <span>{error}；当前分拣服务 {base}，请检查设置中心的“分拣服务地址”。</span>
          <Button variant="secondary" small onClick={refresh}>
            重试
          </Button>
        </div>
      ) : null}

      {loading && records.length === 0 ? (
        <div className="rfid-loading" role="status">
          <span className="skeleton rfid-skeleton" />
          <span className="skeleton rfid-skeleton" />
          <span className="skeleton rfid-skeleton" />
        </div>
      ) : records.length === 0 ? (
        error ? null : (
          <EmptyState
            className="ops-empty"
            icon={<PackageOpen size={34} aria-hidden="true" />}
            title="还没有快递记录"
            description="分拣完成一件后，sorter-api 会写入记录；这里只展示接口返回的数据。"
            actions={
              <Button variant="secondary" onClick={refresh}>
                刷新记录
              </Button>
            }
          />
        )
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table parcel-table">
              <thead>
                <tr>
                  <th>完成时间</th>
                  <th>编号</th>
                  <th>省份</th>
                  <th>分类</th>
                  <th>舵机</th>
                  <th>OCR</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((record, index) => (
                  <tr key={record.file || `${record.timestamp}-${record.pid}-${index}`}>
                    <td className="parcel-time num">{record.time || '—'}</td>
                    <td className="num">{record.pid ? `P${record.pid}` : '—'}</td>
                    <td>{record.province || '—'}</td>
                    <td>
                      {record.category ? (
                        <Badge tone={categoryTone(record.category)}>{record.category}</Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{record.servo ? `舵机 ${record.servo}` : '—'}</td>
                    <td className="num">{record.ocr_calls ? `${record.ocr_calls} 次` : '—'}</td>
                    <td className="parcel-result">{record.result || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-pagination">
            <span>
              第 {startRow}–{endRow} 条 / 共 {records.length} 条
            </span>
            <div className="ops-pagination__actions">
              <Button
                variant="secondary"
                small
                disabled={currentPage <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <span className="ops-pagination__page">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="secondary"
                small
                disabled={currentPage >= totalPages || loading}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}

      <p className="settings-note">
        记录来自 sorter-api 的 `/records`，接口不支持游标分页；本页一次读取最近 {FETCH_LIMIT} 条并在前端分页。`pid` 在分拣程序重启后会重新计数。
      </p>
    </section>
  )
}
