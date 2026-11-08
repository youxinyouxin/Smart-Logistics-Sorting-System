import { useEffect, useMemo, useState } from 'react'
import { Eye, MapPinned, RotateCcw } from 'lucide-react'
import { Badge, DemoBadge } from '../components/ui/Badge'
import { EnvironmentChart } from '../components/charts/EnvironmentChart'
import { Pm25Gauge } from '../components/charts/Pm25Gauge'
import { ChinaMap } from '../components/charts/ChinaMap'
import { RankingList } from '../components/charts/RankingList'
import { useDataSource } from '../lib/useDataSource'
import { useSettings } from '../lib/settings'
import { useMediaQuery } from '../lib/useMediaQuery'
import { DEMO_DATE, DEMO_REGIONS, DEMO_TOTAL, getDemoRanking, regionValue } from '../lib/demo'
import { formatClock, formatDecimal, formatInteger, formatPercent } from '../lib/format'
import type { MetricReading } from '../types'
import '../styles/charts.css'

interface ReadingProps {
  label: string
  reading: MetricReading | undefined
  decimals: number
  kind: 'temp' | 'humidity' | 'light'
}

function Reading({ label, reading, decimals, kind }: ReadingProps) {
  const missing = !reading
  const value = reading?.value
  const formatted =
    value === undefined || value === null
      ? '—'
      : decimals > 0
        ? formatDecimal(value, decimals)
        : formatInteger(value)
  return (
    <div className={`reading reading--${kind}${missing ? ' reading--missing' : ''}`}>
      <span className="reading__label">
        <i
          style={{
            background: kind === 'temp' ? 'var(--data-temp)' : kind === 'humidity' ? 'var(--data-humidity)' : 'var(--data-light)',
          }}
          aria-hidden="true"
        />
        {label}
      </span>
      <span className="reading__value num">
        {formatted}
        {!missing ? <span className="reading__unit">{reading?.unit}</span> : null}
      </span>
    </div>
  )
}

export function DashboardPage() {
  const { readings, history, historyLoading, historyError, connectionState, now } = useDataSource()
  const { settings } = useSettings()
  const isNarrow = useMediaQuery('(max-width: 767px)')
  const [selectedMinuteKey, setSelectedMinuteKey] = useState<string | null>(null)
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)

  const theme = settings.appearance.theme
  const decimals = settings.refresh.decimals
  const windowMinutes = isNarrow ? 30 : 60
  const ranking = useMemo(() => getDemoRanking(), [])
  const selectedValue = selectedRegion ? regionValue(selectedRegion) ?? 0 : null
  const selectedShare = selectedRegion && selectedValue !== null ? formatPercent(selectedValue, DEMO_TOTAL) : null
  const pm25 = readings.pm25
  const pm25Status = !pm25
    ? '无数据'
    : pm25.stale
      ? '数据已过期'
      : pm25.value <= settings.thresholds.pm25GoodMax
        ? '优'
        : pm25.value <= settings.thresholds.pm25MidMax
          ? '良'
          : '超标'
  const pm25Tone = pm25Status === '优' ? 'ok' : pm25Status === '良' ? 'warn' : pm25Status === '超标' ? 'danger' : 'neutral'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSelectedMinuteKey(null)
      setSelectedRegion(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="dashboard">
      <div className="dashboard__top">
        <section className="panel env-panel" aria-labelledby="env-title">
          <div className="env-panel__head">
            <h2 className="panel__title" id="env-title">
              车间环境
            </h2>
          </div>

          <div className="env-panel__mobile-pm">
            <span>PM2.5</span>
            <strong className="num">{pm25 ? Math.round(pm25.value) : '—'}</strong>
            <span>μg/m³</span>
            <Badge tone={pm25Tone}>{pm25Status}</Badge>
          </div>

          <div className="current-readings">
            <Reading label="温度" reading={readings.temperature} decimals={decimals} kind="temp" />
            <Reading label="湿度" reading={readings.humidity} decimals={decimals} kind="humidity" />
            <Reading label="光照" reading={readings.illumination} decimals={0} kind="light" />
          </div>

          <EnvironmentChart
            history={history}
            windowMinutes={windowMinutes}
            selectedKey={selectedMinuteKey}
            onSelectMinute={setSelectedMinuteKey}
            theme={theme}
            loading={historyLoading}
          />
          <p className="chart-note">
            温度/湿度柱按当前窗口聚合成最多 10 组，光照折线保留分钟点（量程固定 0–700 lx）；历史读取服务端分钟数据，缺失分钟按前后相邻数据平均补齐。
            {historyLoading ? ' 正在读取最近 60 分钟历史…' : ''}
            {historyError ? ` 历史读取失败：${historyError}；曲线仅显示已有缓存与本次会话数据。` : ''}
            {connectionState === 'error' ? ' 环境数据连接中断，等待恢复。' : ''}
          </p>
        </section>

        <section className="panel pm-panel" aria-labelledby="pm-title">
          <div className="pm-panel__head">
            <h2 className="panel__title" id="pm-title">
              空气颗粒物
            </h2>
            <Badge tone={readings.pm25?.stale ? 'warn' : 'neutral'}>
              {readings.pm25?.stale ? '数据已过期' : '按显示量程'}
            </Badge>
          </div>
          <Pm25Gauge
            value={readings.pm25?.value ?? null}
            stale={Boolean(readings.pm25?.stale)}
            now={now}
            thresholds={settings.thresholds}
            theme={theme}
          />
        </section>
      </div>

      <div className="dashboard__map">
        <section className="panel map-panel" aria-labelledby="map-title">
          <div className="map-header">
            <div>
              <div className="map-header__title-row">
                <h2 className="panel__title" id="map-title">
                  今日分拣去向
                </h2>
                <DemoBadge date={DEMO_DATE} />
              </div>
              <div className="map-header__meta">
                <span>{DEMO_DATE}</span>
                <span>·</span>
                <span>32 个省级地区</span>
                <span>·</span>
                <span>港澳不参与统计</span>
              </div>
            </div>
            <div className="map-header__total">
              <strong className="num">{formatInteger(DEMO_TOTAL)} 件</strong>
              <span>今日合计 · 演示</span>
            </div>
          </div>

          <ChinaMap data={DEMO_REGIONS} selected={selectedRegion} onSelect={setSelectedRegion} theme={theme} />

          <div className="map-info">
            {selectedRegion && selectedValue !== null ? (
              <div className="map-info__text">
                <strong>{selectedRegion}</strong>
                <span>今日 {formatInteger(selectedValue)} 件</span>
                <span>占比 {selectedShare}</span>
                <span>统计日期 {DEMO_DATE}</span>
                <Badge tone="demo">演示数据</Badge>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => setSelectedRegion(null)}>
                  <RotateCcw size={15} aria-hidden="true" />
                  清除选择
                </button>
              </div>
            ) : (
              <div className="map-info__hint">
                <MapPinned size={16} aria-hidden="true" /> 点击省份或立体柱查看今日数量；也可在右侧排行精确选择。
              </div>
            )}
            <span className="map-legend">
              <span>
                <i className="legend-mark legend-mark--bar" aria-hidden="true" /> 柱高=件数
              </span>
              <span>
                <i className="legend-mark" aria-hidden="true" /> 零值
              </span>
              <span>
                <i className="legend-mark legend-mark--off" aria-hidden="true" /> 不统计（港澳）
              </span>
            </span>
          </div>
          <p className="chart-note">
            演示数据固定于 2026-11-03，刷新不变化；接入真实统计后替换数据源并保留同样的展示结构。
          </p>
        </section>

        <RankingList data={ranking} total={DEMO_TOTAL} selected={selectedRegion} onSelect={setSelectedRegion} demo />
      </div>

      <div className="dashboard-footnote">
        <Eye size={16} aria-hidden="true" />
        <span>当前时间：{formatClock(now)}；环境数据来自接口快照与分钟历史，地图为演示数据，二者不可混读。</span>
      </div>
    </div>
  )
}
