import { useId } from 'react'
import { CircleAlert, CircleCheck, CircleMinus, CircleSlash, Clock, TriangleAlert } from 'lucide-react'
import type { Thresholds } from '../../types'
import { formatClock } from '../../lib/format'
import '../../styles/charts.css'

export interface Pm25GaugeProps {
  value: number | null
  stale: boolean
  now: number
  thresholds: Thresholds
  theme: 'light' | 'dark'
}

interface PmPalette {
  good: string
  mid: string
  high: string
  danger: string
  midText: string
  track: string
  tick: string
  text1: string
  text2: string
  text3: string
}

const PM_PALETTES: Record<'light' | 'dark', PmPalette> = {
  light: {
    good: '#3e8e5a',
    mid: '#c9a227',
    high: '#c05621',
    danger: '#b3261e',
    midText: '#8a6200',
    track: '#e8ebef',
    tick: '#ffffff',
    text1: '#26313d',
    text2: '#5b6573',
    text3: '#6b7684',
  },
  dark: {
    good: '#5bbd8a',
    mid: '#d6b24a',
    high: '#e08a4f',
    danger: '#ff8a80',
    midText: '#d6b24a',
    track: '#262d35',
    tick: '#e9edf2',
    text1: '#e9edf2',
    text2: '#a9b3bf',
    text3: '#8b96a3',
  },
}

const SIZE = 220
const CENTER = SIZE / 2
const STROKE = 28
const RADIUS = (SIZE - STROKE) / 2
const INNER_EDGE = RADIUS - STROKE / 2
const START_ANGLE = 135
const SWEEP = 270

interface Point {
  x: number
  y: number
}

function polar(radius: number, angle: number): Point {
  const radians = (angle * Math.PI) / 180
  return { x: CENTER + radius * Math.cos(radians), y: CENTER + radius * Math.sin(radians) }
}

function arcPath(fromFraction: number, toFraction: number): string {
  const startAngle = START_ANGLE + SWEEP * fromFraction
  const endAngle = START_ANGLE + SWEEP * toFraction
  const start = polar(RADIUS, startAngle)
  const end = polar(RADIUS, endAngle)
  const largeArc = SWEEP * (toFraction - fromFraction) > 180 ? 1 : 0
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function formatThreshold(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)))
}

export function Pm25Gauge({ value, stale, now, thresholds, theme }: Pm25GaugeProps) {
  const rawId = useId()
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '')
  const palette = PM_PALETTES[theme]

  const displayMaxRaw = thresholds.pm25DisplayMax
  const displayMax = Number.isFinite(displayMaxRaw) && displayMaxRaw > 0 ? displayMaxRaw : 1
  const goodMax = thresholds.pm25GoodMax
  const midMax = Math.max(thresholds.pm25MidMax, thresholds.pm25GoodMax)

  const empty = value === null || value === undefined
  const numeric = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const valid = numeric !== null

  const fraction = numeric === null ? 0 : clampFraction(numeric / displayMax)
  const overRange = numeric !== null && numeric > displayMax

  let gradeLabel = '无数据'
  let gradeColor = palette.text3
  let valueColor = palette.text3
  let GradeIcon = CircleMinus

  if (numeric !== null) {
    if (numeric <= goodMax) {
      gradeLabel = '优'
      gradeColor = palette.good
      GradeIcon = CircleCheck
      valueColor = palette.text1
    } else if (numeric <= midMax) {
      gradeLabel = '良'
      gradeColor = palette.midText
      GradeIcon = CircleAlert
      valueColor = palette.text1
    } else {
      gradeLabel = '超标'
      gradeColor = overRange ? palette.danger : palette.high
      GradeIcon = TriangleAlert
      valueColor = gradeColor
    }
  } else if (!empty) {
    gradeLabel = '数据无效'
    gradeColor = palette.danger
    GradeIcon = TriangleAlert
  } else {
    GradeIcon = CircleSlash
  }

  if (stale && numeric !== null) valueColor = palette.text2

  const goodFraction = clampFraction(goodMax / displayMax)
  const midFraction = clampFraction(midMax / displayMax)
  const boundaries = [0, Math.min(goodFraction, 1), Math.min(Math.max(midFraction, goodFraction), 1), 1]
  const segments = [
    { from: boundaries[0], to: boundaries[1], fromColor: palette.good, toColor: palette.mid },
    { from: boundaries[1], to: boundaries[2], fromColor: palette.mid, toColor: palette.high },
    { from: boundaries[2], to: boundaries[3], fromColor: palette.high, toColor: palette.danger },
  ]
    .filter((segment) => segment.to - segment.from > 0.0005)
    .map((segment, index) => {
      const start = polar(RADIUS, START_ANGLE + SWEEP * segment.from)
      const end = polar(RADIUS, START_ANGLE + SWEEP * segment.to)
      return { ...segment, id: `${uid}-seg-${index}`, x1: start.x, y1: start.y, x2: end.x, y2: end.y }
    })

  const ticks = [
    { value: goodMax, fraction: goodFraction },
    { value: midMax, fraction: midFraction },
  ].filter((tick) => tick.fraction > 0.0005 && tick.fraction < 0.9995)

  const updatedText = formatClock(now)
  const displayValue = numeric === null ? '—' : String(Math.round(numeric))
  const ariaLabel =
    numeric === null
      ? `PM2.5 ${gradeLabel}`
      : `PM2.5 浓度 ${Math.round(numeric)} 微克每立方米，${gradeLabel}${stale ? '，数据已过期' : ''}`

  return (
    <div className="pm-gauge-wrap">
      <div
        className={`pm-gauge${stale ? ' pm-gauge--stale' : ''}${valid ? '' : ' pm-empty'}`}
        role="img"
        aria-label={ariaLabel}
      >
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" focusable="false">
          <defs>
            {segments.map((segment) => (
              <linearGradient
                key={segment.id}
                id={segment.id}
                gradientUnits="userSpaceOnUse"
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
              >
                <stop offset="0%" style={{ stopColor: segment.fromColor }} />
                <stop offset="100%" style={{ stopColor: segment.toColor }} />
              </linearGradient>
            ))}
          </defs>

          <path
            d={arcPath(0, 1)}
            fill="none"
            stroke={palette.track}
            strokeWidth={STROKE}
            strokeLinecap="butt"
          />

          <g className="pm-gauge__arcs">
            {segments.map((segment) => {
              const visibleEnd = Math.min(segment.to, fraction)
              if (visibleEnd - segment.from <= 0.0005) return null
              return (
                <path
                  key={segment.id}
                  d={arcPath(segment.from, visibleEnd)}
                  fill="none"
                  stroke={`url(#${segment.id})`}
                  strokeWidth={STROKE}
                  strokeLinecap="butt"
                />
              )
            })}
          </g>

          {ticks.map((tick) => {
            const angle = START_ANGLE + SWEEP * tick.fraction
            const outer = polar(INNER_EDGE + STROKE, angle)
            const inner = polar(INNER_EDGE, angle)
            const label = polar(INNER_EDGE - 16, angle)
            return (
              <g key={`tick-${tick.value}`}>
                <line
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={palette.tick}
                  strokeWidth={2}
                />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={palette.text2}
                  fontSize={13}
                >
                  {formatThreshold(tick.value)}
                </text>
              </g>
            )
          })}
        </svg>

        <div className="pm-center">
          <span className="pm-center__value num" style={{ color: valueColor }}>
            {displayValue}
          </span>
          <span className="pm-center__unit">μg/m³</span>
          <span className="pm-status pm-grade" style={{ color: gradeColor }}>
            <GradeIcon size={18} aria-hidden="true" />
            {gradeLabel}
          </span>
        </div>
      </div>

      <p className="pm-range">
        显示量程 0–{formatThreshold(displayMax)} · 分级阈值 {formatThreshold(goodMax)}/{formatThreshold(midMax)} · 非健康标准
      </p>

      {overRange || stale ? (
        <div className="pm-flags">
          {overRange ? (
            <span className="badge badge--danger pm-overrange">
              <TriangleAlert size={14} aria-hidden="true" />
              超出显示量程
            </span>
          ) : null}
          {stale ? (
            <span className="badge badge--warn pm-stale">
              <Clock size={14} aria-hidden="true" />
              数据已过期
            </span>
          ) : null}
        </div>
      ) : null}

      <p className="pm-source">当前时间 {updatedText}</p>
    </div>
  )
}
