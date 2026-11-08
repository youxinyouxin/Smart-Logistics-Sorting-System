import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { ECharts, EChartsCoreOption } from 'echarts/core'
import type { MetricKey, MinutePoint, SourceKey } from '../../types'
import { METRIC_UNITS, formatDecimal, formatInteger, minuteKey, pad } from '../../lib/format'
import '../../styles/charts.css'

echarts.use([BarChart, LineChart, GridComponent, MarkLineComponent, CanvasRenderer])

export interface EnvironmentChartProps {
  history: MinutePoint[]
  windowMinutes: number
  selectedKey: string | null
  onSelectMinute: (key: string | null) => void
  theme: 'light' | 'dark'
  loading?: boolean
}

type ChartTheme = 'light' | 'dark'

interface ChartPalette {
  temp: string
  humidity: string
  light: string
  grid: string
  axis: string
  select: string
  zero: string
}

const PALETTES: Record<ChartTheme, ChartPalette> = {
  light: {
    temp: '#b84b44',
    humidity: '#2f6fb0',
    light: '#2e8b57',
    grid: '#e8ebef',
    axis: '#6b7684',
    select: '#8a6200',
    zero: '#c7ced6',
  },
  dark: {
    temp: '#e08079',
    humidity: '#7fb2e5',
    light: '#7ed9a5',
    grid: '#333c46',
    axis: '#8b96a3',
    select: '#f2c200',
    zero: '#46515d',
  },
}

interface ChartSlot {
  key: string
  label: string
  temperature: number | null
  humidity: number | null
  illumination: number | null
  sources: Partial<Record<MetricKey, SourceKey>>
}

interface ChartScale {
  leftMin: number
  leftMax: number
  leftInterval: number | undefined
  rightMax: number
  rightInterval: number
  hint: string
}

const MINUTE_MS = 60_000

function toNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function buildSlots(history: MinutePoint[], windowMinutes: number): ChartSlot[] {
  if (!history.length) return []
  const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const anchor = Number.isFinite(last.timestamp) ? last.timestamp : Date.now()
  const firstAnchor = Number.isFinite(first.timestamp) ? first.timestamp : anchor
  const lastMinute = Math.floor(anchor / MINUTE_MS) * MINUTE_MS
  const firstMinute = Math.floor(firstAnchor / MINUTE_MS) * MINUTE_MS
  const spannedMinutes = Math.floor((lastMinute - firstMinute) / MINUTE_MS) + 1
  const byKey = new Map<string, MinutePoint>()
  for (const point of sorted) byKey.set(point.key, point)
  const count = Math.max(1, Math.min(Math.round(windowMinutes), spannedMinutes))
  const slots: ChartSlot[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(lastMinute - offset * MINUTE_MS)
    const key = minuteKey(date)
    const point = byKey.get(key)
    slots.push({
      key,
      label: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
      temperature: toNumber(point?.temperature),
      humidity: toNumber(point?.humidity),
      illumination: toNumber(point?.illumination),
      sources: point?.sources ?? {},
    })
  }
  return slots
}

function buildScale(slots: ChartSlot[]): ChartScale {
  const temperatures: number[] = []
  const humidities: number[] = []
  for (const slot of slots) {
    if (slot.temperature !== null) temperatures.push(slot.temperature)
    if (slot.humidity !== null) humidities.push(slot.humidity)
  }

  const hints: string[] = []
  let leftMin = 0
  let leftMax = 80
  if (humidities.some((value) => value > 80)) {
    leftMax = 100
    hints.push('湿度上限 100')
  }
  if (temperatures.length) {
    const minTemperature = Math.min(...temperatures)
    if (minTemperature < 0) {
      leftMin = minTemperature < -10 ? -20 : -10
      hints.push(`温度下限 ${leftMin}`)
    }
  }

  const leftInterval = leftMin === 0 && leftMax === 80 ? 20 : leftMin === 0 && leftMax === 100 ? 25 : undefined
  return {
    leftMin,
    leftMax,
    leftInterval,
    rightMax: 700,
    rightInterval: 100,
    hint: hints.join('、'),
  }
}

interface BarBucket {
  label: string
  temperature: number | null
  humidity: number | null
}

const MAX_BAR_BUCKETS = 10

function average(values: (number | null)[]): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function buildBarBuckets(slots: ChartSlot[]): BarBucket[] {
  if (!slots.length) return []
  const bucketSize = Math.max(1, Math.ceil(slots.length / MAX_BAR_BUCKETS))
  const buckets: BarBucket[] = []
  for (let start = 0; start < slots.length; start += bucketSize) {
    const chunk = slots.slice(start, start + bucketSize)
    const center = chunk[Math.floor(chunk.length / 2)] ?? chunk[0]
    buckets.push({
      label: center.label,
      temperature: average(chunk.map((slot) => slot.temperature)),
      humidity: average(chunk.map((slot) => slot.humidity)),
    })
  }
  return buckets
}

interface ReadoutMetricProps {
  label: string
  value: number | null
  unit: string
  decimals: number
}

function ReadoutMetric({ label, value, unit, decimals }: ReadoutMetricProps) {
  const missing = value === null || !Number.isFinite(value)
  return (
    <span className="chart-readout__seg">
      <span>{label}</span>
      <strong className="num">{missing ? '—' : decimals > 0 ? formatDecimal(value, decimals) : formatInteger(value)}</strong>
      {!missing && <span className="chart-readout__unit">{unit}</span>}
      {missing ? <small className="chart-readout__source">无数据</small> : null}
    </span>
  )
}

export function EnvironmentChart({ history, windowMinutes, selectedKey, onSelectMinute, theme, loading = false }: EnvironmentChartProps) {
  const chartElRef = useRef<HTMLDivElement | null>(null)
  const instanceRef = useRef<ECharts | null>(null)
  const [chartWidth, setChartWidth] = useState(0)

  const palette = PALETTES[theme]
  const slots = useMemo(() => buildSlots(history, windowMinutes), [history, windowMinutes])
  const scale = useMemo(() => buildScale(slots), [slots])
  const selectedSlot = useMemo(
    () => (selectedKey ? slots.find((slot) => slot.key === selectedKey) ?? null : null),
    [slots, selectedKey],
  )
  const barBuckets = useMemo(() => buildBarBuckets(slots), [slots])
  const selectedBucket = useMemo(() => {
    if (!selectedSlot || !barBuckets.length) return -1
    const index = slots.findIndex((slot) => slot.key === selectedSlot.key)
    if (index < 0) return -1
    const bucketSize = Math.max(1, Math.ceil(slots.length / MAX_BAR_BUCKETS))
    return Math.min(barBuckets.length - 1, Math.floor(index / bucketSize))
  }, [barBuckets, selectedSlot, slots])
  const hasLight = useMemo(
    () =>
      history.length === 0 ||
      history.some((point) => toNumber(point.illumination) !== null || point.sources.illumination !== undefined),
    [history],
  )
  const isEmpty = slots.length === 0
  const barCategoryWidth = barBuckets.length
    ? Math.max(0, chartWidth - 46 - (hasLight ? 52 : 20)) / barBuckets.length
    : 0
  const barGroupWidth = Math.max(8, Math.min(36, barCategoryWidth * 0.6))
  const barWidth = Math.max(2, Math.floor((barGroupWidth - 1) / 2))
  const barGap = '10%'

  useEffect(() => {
    const element = chartElRef.current
    if (!element) return
    const chart = echarts.init(element, undefined, { renderer: 'canvas' })
    instanceRef.current = chart
    setChartWidth(element.clientWidth)
    const observer = new ResizeObserver(() => {
      if (chart.isDisposed()) return
      setChartWidth(element.clientWidth)
      chart.resize()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      chart.dispose()
      instanceRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = instanceRef.current
    if (!chart) return
    if (!slots.length) {
      chart.clear()
      return
    }

    const categories = slots.map((slot) => slot.label)
    const step = windowMinutes <= 30 ? 10 : 5
    const labelInterval = (index: number) => {
      if (index === 0 || index === slots.length - 1) return true
      const slot = slots[index]
      if (!slot) return false
      const minute = Number(slot.label.slice(3))
      if (!Number.isFinite(minute) || minute % step !== 0) return false
      return index >= 2 && index <= slots.length - 3
    }

    const bucketData = (key: 'temperature' | 'humidity') =>
      barBuckets.map((bucket, index) => {
        const value = bucket[key]
        if (value === null) return null
        if (index === selectedBucket) {
          return { value, itemStyle: { borderColor: palette.select, borderWidth: 2 } }
        }
        return value
      })

    const markLineData: Record<string, unknown>[] = []
    if (selectedSlot) {
      markLineData.push({
        xAxis: selectedSlot.label,
        lineStyle: { color: palette.select, width: 1, type: 'solid' },
      })
    }
    if (scale.leftMin < 0) {
      markLineData.push({ yAxis: 0, lineStyle: { color: palette.zero, width: 1, type: 'solid' } })
    }

    const option: EChartsCoreOption = {
      animation: false,
      backgroundColor: 'transparent',
      grid: {
        left: 46,
        right: hasLight ? 52 : 20,
        top: 24,
        bottom: 26,
        containLabel: false,
      },
      xAxis: [
        {
          type: 'category',
          data: categories,
          boundaryGap: true,
          axisLine: { lineStyle: { color: palette.zero } },
          axisTick: { show: false },
          axisLabel: { color: palette.axis, fontSize: 11, margin: 8, interval: labelInterval, rotate: 0 },
          splitLine: { show: false },
        },
        {
          type: 'category',
          data: barBuckets.map((bucket) => bucket.label),
          boundaryGap: true,
          show: false,
        },
      ],
      yAxis: [
        {
          type: 'value',
          min: scale.leftMin,
          max: scale.leftMax,
          interval: scale.leftInterval,
          splitNumber: 4,
          name: '°C / %RH',
          nameLocation: 'end',
          nameGap: 6,
          nameTextStyle: { color: palette.axis, fontSize: 11, align: 'left' },
          axisLine: { show: true, lineStyle: { color: palette.zero } },
          axisTick: { show: false },
          axisLabel: { color: palette.axis, fontSize: 11, formatter: (value: number) => String(value) },
          splitLine: { show: true, lineStyle: { color: palette.grid, width: 1 } },
        },
        {
          type: 'value',
          min: 0,
          max: scale.rightMax,
          interval: scale.rightInterval,
          show: hasLight,
          name: 'lx',
          nameLocation: 'end',
          nameGap: 6,
          nameTextStyle: { color: palette.axis, fontSize: 11, align: 'right' },
          axisLine: { show: true, lineStyle: { color: palette.zero } },
          axisTick: { show: false },
          axisLabel: { color: palette.axis, fontSize: 11, formatter: (value: number) => String(value) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '湿度',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 0,
          data: bucketData('humidity'),
          barWidth,
          barGap,
          z: 1,
          itemStyle: {
            color: palette.humidity,
            opacity: 0.85,
            borderWidth: 0,
          },
        },
        {
          name: '温度',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 0,
          data: bucketData('temperature'),
          barWidth,
          barGap,
          z: 2,
          itemStyle: {
            color: palette.temp,
            borderWidth: 0,
          },
        },
        {
          name: '选中线',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: slots.map(() => null),
          showSymbol: false,
          silent: true,
          z: 4,
          lineStyle: { opacity: 0 },
          markLine:
            markLineData.length > 0
              ? {
                  silent: true,
                  symbol: 'none',
                  animation: false,
                  label: { show: false },
                  data: markLineData,
                }
              : undefined,
        },
        {
          name: '光照',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 1,
          data: slots.map((slot) => slot.illumination),
          show: hasLight,
          showSymbol: slots.length <= 6,
          symbolSize: 6,
          connectNulls: false,
          smooth: false,
          z: 3,
          lineStyle: { width: 4, color: palette.light },
          itemStyle: { color: palette.light },
        },
      ],
    }

    chart.setOption(option, { notMerge: true })
  }, [
    slots,
    scale,
    selectedSlot,
    selectedBucket,
    barBuckets,
    hasLight,
    theme,
    palette,
    windowMinutes,
    barWidth,
    barGap,
  ])

  useEffect(() => {
    const chart = instanceRef.current
    if (!chart || !slots.length) return
    const handleClick = (event: { offsetX: number; offsetY: number }) => {
      const point: [number, number] = [event.offsetX, event.offsetY]
      if (!chart.containPixel({ gridIndex: 0 }, point)) {
        if (selectedKey !== null) onSelectMinute(null)
        return
      }
      try {
        const pixel = chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX)
        const index = Array.isArray(pixel) ? Number(pixel[0]) : Number(pixel)
        if (!Number.isFinite(index)) return
        const slot = slots[Math.round(index)]
        if (!slot) return
        onSelectMinute(selectedKey === slot.key ? null : slot.key)
      } catch {
        if (selectedKey !== null) onSelectMinute(null)
      }
    }
    const zr = chart.getZr()
    zr.on('click', handleClick)
    return () => {
      if (!chart.isDisposed()) zr.off('click', handleClick)
    }
  }, [slots, selectedKey, onSelectMinute])

  useEffect(() => {
    if (!selectedKey) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onSelectMinute(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedKey, onSelectMinute])

  return (
    <>
      <div className="chart-legend" aria-label="图例">
        <span className="chart-legend__item">
          <i
            className="chart-legend__swatch chart-legend__swatch--temp"
            style={{ background: palette.temp }}
            aria-hidden="true"
          />
          温度 {METRIC_UNITS.temperature}
        </span>
        <span className="chart-legend__item">
          <i
            className="chart-legend__swatch chart-legend__swatch--humidity"
            style={{ background: palette.humidity }}
            aria-hidden="true"
          />
          湿度 {METRIC_UNITS.humidity}
        </span>
        <span className={`chart-legend__item${hasLight ? '' : ' chart-legend__item--off'}`}>
          <i className="chart-legend__line" style={{ background: palette.light }} aria-hidden="true" />
          光照 {METRIC_UNITS.illumination}
          {hasLight ? '' : '（未接入）'}
        </span>
      </div>

      {scale.hint ? (
        <p className="chart-note chart-axis-hint axis-expanded" role="status">
          坐标轴已扩展：{scale.hint}
        </p>
      ) : null}

      <div className="chart-box">
        <div ref={chartElRef} className="chart-canvas" />
        {isEmpty ? (
          <div className="chart-empty" role="status">
            {loading ? '正在读取最近 60 分钟历史…' : '暂无环境历史数据；当前会话的实时数据会在新分钟到达后显示'}
          </div>
        ) : null}
      </div>

      <div className={`chart-readout${selectedSlot ? '' : ' chart-readout--empty'}`} aria-live="polite">
        {selectedSlot ? (
          <>
            <span className="chart-readout__seg">
              <strong className="num">{selectedSlot.label}</strong>
            </span>
            <ReadoutMetric
              label="温度"
              value={selectedSlot.temperature}
              unit={METRIC_UNITS.temperature}
              decimals={1}
            />
            <ReadoutMetric
              label="湿度"
              value={selectedSlot.humidity}
              unit={METRIC_UNITS.humidity}
              decimals={1}
            />
            <ReadoutMetric
              label="光照"
              value={selectedSlot.illumination}
              unit={METRIC_UNITS.illumination}
              decimals={0}
            />
            <button
              type="button"
              className="btn btn--ghost btn--small chart-readout__clear"
              onClick={() => onSelectMinute(null)}
            >
              <X size={16} aria-hidden="true" />
              清除
            </button>
          </>
        ) : (
          <span>点击图表中的分钟锁定三值读数 · 再次点击或按 Esc 取消</span>
        )}
      </div>
    </>
  )
}
