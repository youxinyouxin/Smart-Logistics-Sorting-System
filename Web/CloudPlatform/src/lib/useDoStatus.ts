import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, getDoStatus } from './api'
import { useSettings } from './settings'

interface DoStatusValue {
  doMap: Record<string, boolean>
  error: string | null
  lastUpdatedAt: number | null
  refreshing: boolean
  refresh: () => void
  updateChannel: (channel: number, value: boolean) => void
}

export function useDoStatus(enabled = true): DoStatusValue {
  const { settings } = useSettings()
  const [doMap, setDoMap] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const inFlightRef = useRef(false)
  const lastBaseRef = useRef(settings.apiBaseUrl)

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

  useEffect(() => {
    if (lastBaseRef.current === settings.apiBaseUrl) return
    lastBaseRef.current = settings.apiBaseUrl
    setDoMap({})
    setError(null)
    setLastUpdatedAt(null)
  }, [settings.apiBaseUrl])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: number | null = null
    let controller: AbortController | null = null

    const schedule = () => {
      if (cancelled || document.hidden) return
      timer = window.setTimeout(fetchStatus, 15000)
    }

    const fetchStatus = async () => {
      if (cancelled || document.hidden || inFlightRef.current) return
      inFlightRef.current = true
      controller?.abort()
      controller = new AbortController()
      setRefreshing(true)
      try {
        const next = await getDoStatus(settings.apiBaseUrl, controller.signal)
        if (cancelled) return
        setDoMap(next)
        setError(null)
        setLastUpdatedAt(Date.now())
      } catch (caught) {
        if (cancelled) return
        const message = errorMessage(caught)
        if (message !== '请求已取消') setError(message)
      } finally {
        inFlightRef.current = false
        if (!cancelled) {
          setRefreshing(false)
          schedule()
        }
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== null) window.clearTimeout(timer)
        controller?.abort()
      } else {
        if (timer !== null) window.clearTimeout(timer)
        void fetchStatus()
      }
    }

    void fetchStatus()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
      inFlightRef.current = false
    }
  }, [enabled, settings.apiBaseUrl, refreshNonce])

  const updateChannel = useCallback((channel: number, value: boolean) => {
    setDoMap((previous) => ({ ...previous, [`DO${channel}`]: value }))
  }, [])

  return { doMap, error, lastUpdatedAt, refreshing, refresh, updateChannel }
}
