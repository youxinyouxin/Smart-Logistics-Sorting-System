import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw, UserRoundCheck, Users } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { LogTerminal } from '../components/operations/LogTerminal'
import { ParcelRecordsPanel } from '../components/operations/ParcelRecordsPanel'
import { useSettings } from '../lib/settings'
import { errorMessage, getRfidRecords } from '../lib/api'
import type { RfidRecord } from '../types'
import '../styles/operations.css'

type TabKey = 'parcel' | 'attendance'

function AttendancePanel() {
  const { settings } = useSettings()
  const [records, setRecords] = useState<RfidRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const count = 20

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const start = (page - 1) * count + 1
    setLoading(true)
    setError(null)
    getRfidRecords(settings.apiBaseUrl, start, count, controller.signal)
      .then((response) => {
        if (cancelled) return
        setRecords(response.records)
        setTotal(response.total)
        if (response.records.length === 0 && response.total > 0 && page > 1) {
          setPage(Math.max(1, Math.ceil(response.total / count)))
        }
      })
      .catch((caught) => {
        if (cancelled) return
        setError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [settings.apiBaseUrl, page, refreshNonce])

  const totalPages = Math.max(1, Math.ceil(total / count))
  const startRow = total === 0 ? 0 : (page - 1) * count + 1
  const endRow = Math.min(page * count, total)

  return (
    <section className="panel ops-panel" role="tabpanel" aria-label="员工签到">
      <div className="rfid-head">
        <div>
          <div className="section-head__title">读卡器打卡记录</div>
          <div className="ops-panel__hint">
            <Users size={16} aria-hidden="true" /> 累计 {total} 条 · 按时间倒序 · 最近打卡在前
          </div>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={18} aria-hidden="true" />}
          loading={loading}
          onClick={() => setRefreshNonce((value) => value + 1)}
        >
          刷新
        </Button>
      </div>

      {error ? (
        <div className="ops-error" role="alert">
          <strong>打卡记录读取失败</strong>
          <span>{error}</span>
          <Button variant="secondary" small onClick={() => setRefreshNonce((value) => value + 1)}>
            重试
          </Button>
        </div>
      ) : loading ? (
        <div className="rfid-loading" role="status">
          <span className="skeleton rfid-skeleton" />
          <span className="skeleton rfid-skeleton" />
          <span className="skeleton rfid-skeleton" />
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          className="ops-empty"
          icon={<UserRoundCheck size={34} aria-hidden="true" />}
          title="当前还没有打卡记录"
          description="读卡器读到卡后，服务端会写入一条记录；这里只展示接口返回的数据。"
          actions={
            <Button variant="secondary" onClick={() => setRefreshNonce((value) => value + 1)}>
              刷新记录
            </Button>
          }
        />
      ) : (
        <>
          <div className="rfid-list" role="table" aria-label="打卡记录">
            <div className="rfid-row rfid-row--head" role="row">
              <span role="columnheader">姓名</span>
              <span role="columnheader">签到时间</span>
            </div>
            {records.map((record, index) => (
              <div className="rfid-row" role="row" key={`${record.time}-${record.name}-${index}`}>
                <span className="rfid-name" role="cell">
                  {record.name}
                </span>
                <span className="rfid-time num" role="cell">
                  {record.time}
                </span>
              </div>
            ))}
          </div>
          <div className="ops-pagination">
            <span>
              第 {startRow}–{endRow} 条 / 共 {total} 条
            </span>
            <div className="ops-pagination__actions">
              <Button
                variant="secondary"
                small
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <span className="ops-pagination__page">
                {page} / {totalPages}
              </span>
              <Button
                variant="secondary"
                small
                disabled={page >= totalPages || loading}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}

      <p className="settings-note">
        接口只提供姓名与签到时间，因此不计算迟到、缺勤或出勤率；没有工号、班次和应到名单时，这些指标不可推断。
      </p>
    </section>
  )
}

export function OperationsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: TabKey = searchParams.get('tab') === 'attendance' ? 'attendance' : 'parcel'

  const setTab = (next: TabKey) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'parcel') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="operations-page">
      <LogTerminal />

      <div className="ops-tabs" role="tablist" aria-label="运行数据类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'parcel'}
          className={`ops-tab${tab === 'parcel' ? ' ops-tab--active' : ''}`}
          onClick={() => setTab('parcel')}
        >
          快递记录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'attendance'}
          className={`ops-tab${tab === 'attendance' ? ' ops-tab--active' : ''}`}
          onClick={() => setTab('attendance')}
        >
          员工签到
        </button>
      </div>

      {tab === 'parcel' ? <ParcelRecordsPanel /> : <AttendancePanel />}
    </div>
  )
}
