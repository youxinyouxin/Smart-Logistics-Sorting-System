import { useEffect, useRef, useState } from 'react'
import { Terminal } from 'lucide-react'
import { errorMessage } from '../../lib/api'
import { formatClock } from '../../lib/format'
import { getSorterLogs } from '../../lib/sorterApi'
import { useSettings } from '../../lib/settings'

const LOG_LINES = 200
const POLL_MS = 2000

export function LogTerminal() {
  const { settings } = useSettings()
  const base = settings.sorterApiBaseUrl
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const previousTextRef = useRef('')

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    let controller: AbortController | null = null
    let inFlight = false

    setText('')
    setError(null)
    setLoading(true)
    setUpdatedAt(null)

    const fetchLogs = async () => {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      controller?.abort()
      controller = new AbortController()
      try {
        const next = await getSorterLogs(base, LOG_LINES, controller.signal)
        if (cancelled) return
        setText(next.replace(/\s+$/, ''))
        setUpdatedAt(Date.now())
        setError(null)
      } catch (caught) {
        if (cancelled) return
        const message = errorMessage(caught)
        if (message !== '请求已取消') setError(message)
      } finally {
        inFlight = false
        if (!cancelled) {
          setLoading(false)
          if (!document.hidden) timer = window.setTimeout(fetchLogs, POLL_MS)
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
        void fetchLogs()
      }
    }

    void fetchLogs()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [base])

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const firstRender = previousTextRef.current === ''
    previousTextRef.current = text
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    if (firstRender || nearBottom) element.scrollTop = element.scrollHeight
  }, [text])

  const stateClass = error ? 'is-error' : loading ? 'is-loading' : 'is-live'
  const stateText = error ? '连接异常' : loading ? '连接中' : '实时'

  return (
    <section className="log-terminal" aria-label="分拣服务实时日志">
      <div className="log-terminal__bar">
        <span className="log-terminal__dots" aria-hidden="true">
          <i className="log-terminal__dot log-terminal__dot--red" />
          <i className="log-terminal__dot log-terminal__dot--yellow" />
          <i className="log-terminal__dot log-terminal__dot--green" />
        </span>
        <span className="log-terminal__title">
          <Terminal size={16} aria-hidden="true" />
          sorter.log
        </span>
        <span className={`log-terminal__state ${stateClass}`}>
          <i aria-hidden="true" />
          {stateText}
        </span>
        <span className="log-terminal__meta">
          最近 {LOG_LINES} 行 · 2 秒刷新 · 最后更新 {updatedAt ? formatClock(updatedAt, true) : '—'}
        </span>
      </div>
      <div className="log-terminal__body" ref={bodyRef}>
        {error ? <div className="log-terminal__error">日志读取失败：{error}（{base}），正在自动重试…</div> : null}
        {text ? (
          <pre className="log-terminal__pre">{text}</pre>
        ) : loading ? (
          <div className="log-terminal__empty">正在连接分拣服务…</div>
        ) : (
          <div className="log-terminal__empty">{error ? '暂无缓存日志' : '日志文件暂时没有输出'}</div>
        )}
      </div>
    </section>
  )
}
