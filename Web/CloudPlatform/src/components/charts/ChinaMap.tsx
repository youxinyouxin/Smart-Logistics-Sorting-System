import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { DEMO_DATE } from '../../lib/demo'
import {
  CHINA_GEOJSON,
  REGION_CENTROIDS,
  STAT_REGION_NAMES,
  findRegionAt,
  isStatRegion,
  registerChinaMap,
  shortProvinceName,
} from '../../lib/china'
import { formatInteger } from '../../lib/format'
import type { RegionDatum } from '../../types'
import '../../styles/map.css'

export interface ChinaMapProps {
  data: RegionDatum[]
  selected: string | null
  onSelect: (name: string | null) => void
  theme: 'light' | 'dark'
}

type Point = [number, number]
type MapChild = NonNullable<echarts.CustomSeriesRenderItemReturn>

interface Palette {
  land: string
  off: string
  border: string
  hover: string
  selectedFill: string
  selectedBorder: string
  panel: string
  borderStrong: string
  text1: string
}

interface ColumnEntry {
  name: string
  value: number | null
  centroid: Point
  offset: Point
}

interface HitArea {
  name: string
  x1: number
  x2: number
  y1: number
  y2: number
}

interface HoverState {
  name: string
  x: number
  y: number
}

const MAINLAND_MAP_NAME = 'cloudplatform-china-mainland'
const SOUTH_SEA_MAP_NAME = 'cloudplatform-china-jd'
const MAX_BAR_HEIGHT = 56
const MIN_BAR_HEIGHT = 4
const BAR_WIDTH = 7
const SIDE_DX = 5
const SIDE_DY = 3
const ZERO_BAR_WIDTH = 10
const ZERO_BAR_HEIGHT = 2
const MISSING_BASE_WIDTH = 6
const MISSING_BASE_HEIGHT = 10
const COLUMN_GAP = 8
const TOOLTIP_WIDTH = 200
const TOOLTIP_HEIGHT = 82

const FACE_FRONT = '#3E5C66'
const FACE_SIDE = '#2F464E'
const FACE_TOP = '#6E8C96'
const ZERO_BAR_FILL = '#5B6573'
const SELECTED_TOP = '#F2C200'
const SELECTED_TOP_STROKE = '#8A6200'

// 用 boundingCoords 控制视窗比例，避免宽容器把省界横向拉伸。
const MAINLAND_BOUNDS: number[][] = [
  [73.4, 54.2],
  [135.3, 17.4],
]
// 九段线单独作为右下角小图，避免在大陆图里显示成孤立的线框。
const SOUTH_SEA_BOUNDS: number[][] = [
  [108.0, 24.8],
  [123.2, 3.2],
]
const INSET_CENTER: [string, string] = ['84%', '84%']
const INSET_SIZE = '26%'

const REGION_ORDER = Array.from(STAT_REGION_NAMES)

/** 东部密集省份使用不超过 8px 的固定偏移，避免柱体重叠且不把柱子推出省界。 */
const REGION_OFFSETS: Record<string, Point> = {
  北京: [3, -2],
  天津: [5, 2],
  河北: [-2, 1],
  上海: [5, -1],
  江苏: [-3, 2],
  浙江: [2, 3],
  安徽: [-4, 1],
  福建: [3, 2],
  河南: [-1, 1],
  湖北: [1, 1],
  湖南: [2, 1],
  广东: [1, 3],
  海南: [2, 1],
  重庆: [-2, 2],
  宁夏: [-2, -1],
}

function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

let mainlandRegistered = false
let southSeaRegistered = false

function registerMainlandMap(): void {
  if (mainlandRegistered) return
  echarts.registerMap(MAINLAND_MAP_NAME, {
    type: 'FeatureCollection',
    features: CHINA_GEOJSON.features.filter(
      (feature) => String(feature.properties.adcode ?? '') !== '100000_JD',
    ),
  } as never)
  mainlandRegistered = true
}

function registerSouthSeaMap(): void {
  if (southSeaRegistered) return
  echarts.registerMap(SOUTH_SEA_MAP_NAME, {
    type: 'FeatureCollection',
    features: CHINA_GEOJSON.features.filter(
      (feature) => String(feature.properties.adcode ?? '') === '100000_JD',
    ),
  } as never)
  southSeaRegistered = true
}

function isInsideSouthSeaInset(chart: echarts.ECharts, x: number, y: number): boolean {
  const topLeft = chart.convertToPixel({ geoIndex: 1 }, SOUTH_SEA_BOUNDS[0]) as number[] | undefined
  const bottomRight = chart.convertToPixel({ geoIndex: 1 }, SOUTH_SEA_BOUNDS[1]) as number[] | undefined
  if (!topLeft || !bottomRight) return false
  const pad = 4
  const x1 = Math.min(topLeft[0], bottomRight[0]) - pad
  const x2 = Math.max(topLeft[0], bottomRight[0]) + pad
  const y1 = Math.min(topLeft[1], bottomRight[1]) - pad
  const y2 = Math.max(topLeft[1], bottomRight[1]) + pad
  return x >= x1 && x <= x2 && y >= y1 && y <= y2
}

function resolvePalette(theme: 'light' | 'dark'): Palette {
  const dark = theme === 'dark'
  return {
    land: readToken('--map-land', dark ? '#252C34' : '#EEF1F4'),
    off: readToken('--map-off', dark ? '#2F3740' : '#E4E7EB'),
    border: dark ? readToken('--border', '#333C46') : '#FFFFFF',
    hover: readToken('--bg-subtle', dark ? '#25323C' : '#E1F3FD'),
    selectedFill: readToken('--brand-50', dark ? '#3A3218' : '#FFF7D6'),
    selectedBorder: readToken('--brand-700', '#8A6200'),
    panel: readToken('--bg-panel', dark ? '#1D232A' : '#FFFFFF'),
    borderStrong: readToken('--border-strong', dark ? '#46515D' : '#C7CED6'),
    text1: readToken('--text-1', dark ? '#E9EDF2' : '#26313D'),
  }
}

function columnHeight(value: number | null, maxValue: number): number {
  if (value === null || value <= 0 || maxValue <= 0) return 0
  return Math.max(MIN_BAR_HEIGHT, (Math.min(value, maxValue) / maxValue) * MAX_BAR_HEIGHT)
}

function valueText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${formatInteger(value)} 件`
}

function buildMapOption(
  entries: ColumnEntry[],
  maxValue: number,
  selected: string | null,
  palette: Palette,
  boxes: Array<HitArea | undefined>,
): echarts.EChartsOption {
  const selectedEntry = selected ? entries.find((entry) => entry.name === selected) ?? null : null

  const renderColumns: echarts.CustomSeriesRenderItem = (
    params: echarts.CustomSeriesRenderItemParams,
    api: echarts.CustomSeriesRenderItemAPI,
  ) => {
    const entry = entries[params.dataIndex]
    if (!entry) return null

    const point = api.coord(entry.centroid)
    const x = point[0] + entry.offset[0]
    const y = point[1] + entry.offset[1]
    const h = columnHeight(entry.value, maxValue)
    const isSelected = entry.name === selected
    const children: MapChild[] = []

    if (entry.value === null) {
      children.push({
        type: 'rect',
        shape: {
          x: x - MISSING_BASE_WIDTH / 2,
          y: y - MISSING_BASE_HEIGHT,
          width: MISSING_BASE_WIDTH,
          height: MISSING_BASE_HEIGHT,
        },
        style: {
          fill: 'transparent',
          stroke: palette.borderStrong,
          lineWidth: 1,
          lineDash: [2, 2],
        },
      })
    } else if (entry.value <= 0) {
      children.push({
        type: 'rect',
        shape: {
          x: x - ZERO_BAR_WIDTH / 2,
          y: y - ZERO_BAR_HEIGHT,
          width: ZERO_BAR_WIDTH,
          height: ZERO_BAR_HEIGHT,
          r: 1,
        },
        style: { fill: ZERO_BAR_FILL, stroke: ZERO_BAR_FILL, lineWidth: 1 },
      })
    } else {
      const half = BAR_WIDTH / 2
      children.push({
        type: 'polygon',
        shape: {
          points: [
            [x - half, y],
            [x + half, y],
            [x + half, y - h],
            [x - half, y - h],
          ],
        },
        style: { fill: FACE_FRONT, stroke: FACE_FRONT, lineWidth: 1 },
      })
      children.push({
        type: 'polygon',
        shape: {
          points: [
            [x + half, y],
            [x + half + SIDE_DX, y - SIDE_DY],
            [x + half + SIDE_DX, y - h - SIDE_DY],
            [x + half, y - h],
          ],
        },
        style: { fill: FACE_SIDE, stroke: FACE_SIDE, lineWidth: 1 },
      })
      children.push({
        type: 'polygon',
        shape: {
          points: [
            [x - half, y - h],
            [x + half, y - h],
            [x + half + SIDE_DX, y - h - SIDE_DY],
            [x - half + SIDE_DX, y - h - SIDE_DY],
          ],
        },
        style: {
          fill: isSelected ? SELECTED_TOP : FACE_TOP,
          stroke: isSelected ? SELECTED_TOP_STROKE : FACE_TOP,
          lineWidth: 1,
        },
      })
    }

    const topY = entry.value === null ? y - MISSING_BASE_HEIGHT - 2 : y - h - SIDE_DY - 2
    boxes[params.dataIndex] = {
      name: entry.name,
      x1: x - BAR_WIDTH / 2 - 2,
      x2: x + BAR_WIDTH / 2 + SIDE_DX + 2,
      y1: Math.min(topY, y + 2),
      y2: y + 2,
    }

    return { type: 'group', children }
  }

  const renderSelectedLabel: echarts.CustomSeriesRenderItem = (
    _params,
    api: echarts.CustomSeriesRenderItemAPI,
  ) => {
    if (!selectedEntry) return null

    const point = api.coord(selectedEntry.centroid)
    const x = point[0] + selectedEntry.offset[0]
    const y = point[1] + selectedEntry.offset[1]
    const h = columnHeight(selectedEntry.value, maxValue)
    const text = `${selectedEntry.name} ${valueText(selectedEntry.value)}`
    const font = api.font({ fontSize: 12, fontWeight: 500 })
    const measured = echarts.format.getTextRect(text, font)
    const boxWidth = measured.width + 12
    const boxHeight = measured.height + 8
    const halfWidth = boxWidth / 2
    const halfHeight = boxHeight / 2
    const minCenterX = halfWidth + 4
    const maxCenterX = Math.max(minCenterX, api.getWidth() - halfWidth - 4)
    const minCenterY = halfHeight + 4
    const maxCenterY = Math.max(minCenterY, api.getHeight() - halfHeight - 4)
    const anchorX = x + SIDE_DX / 2
    const anchorY =
      selectedEntry.value === null
        ? y - MISSING_BASE_HEIGHT
        : selectedEntry.value <= 0
          ? y - ZERO_BAR_HEIGHT
          : y - h - SIDE_DY
    const sideStep = BAR_WIDTH / 2 + SIDE_DX + COLUMN_GAP + halfWidth

    // 依次尝试柱顶上方左右的候选位置，选离柱顶最近且不压住任何柱体的位置。
    const candidates: Array<{ x: number; y: number }> = []
    for (let level = 0; level < 4; level += 1) {
      const cy = anchorY - COLUMN_GAP - halfHeight - level * (boxHeight + 6)
      candidates.push(
        { x, y: cy },
        { x: x + sideStep, y: cy },
        { x: x - sideStep, y: cy },
        { x: x + sideStep * 2, y: cy },
        { x: x - sideStep * 2, y: cy },
        { x: x + sideStep * 3, y: cy },
        { x: x - sideStep * 3, y: cy },
      )
    }
    const belowCandidates: Array<{ x: number; y: number }> = [
      { x, y: y + COLUMN_GAP + halfHeight },
      { x: x + sideStep, y: y + COLUMN_GAP + halfHeight },
      { x: x - sideStep, y: y + COLUMN_GAP + halfHeight },
      { x: x + sideStep * 2, y: y + COLUMN_GAP + halfHeight },
      { x: x - sideStep * 2, y: y + COLUMN_GAP + halfHeight },
    ]

    const overlapsColumn = (cx: number, cy: number): boolean => {
      const left = cx - halfWidth
      const right = cx + halfWidth
      const top = cy - halfHeight
      const bottom = cy + halfHeight
      return boxes.some(
        (box) =>
          box !== undefined &&
          box.x1 < right &&
          box.x2 > left &&
          box.y1 < bottom &&
          box.y2 > top,
      )
    }

    const pickCandidate = (
      list: Array<{ x: number; y: number }>,
    ): { x: number; y: number } | null => {
      let best: { x: number; y: number } | null = null
      let bestScore = Number.POSITIVE_INFINITY
      for (const candidate of list) {
        const cx = Math.min(Math.max(candidate.x, minCenterX), maxCenterX)
        const cy = Math.min(Math.max(candidate.y, minCenterY), maxCenterY)
        if (overlapsColumn(cx, cy)) continue
        const score = (cx - x) ** 2 + (cy - anchorY) ** 2
        if (score < bestScore) {
          bestScore = score
          best = { x: cx, y: cy }
        }
      }
      return best
    }

    const choice = pickCandidate(candidates) ?? pickCandidate(belowCandidates)
    const labelX = choice ? choice.x : Math.min(Math.max(x, minCenterX), maxCenterX)
    const labelY = choice ? choice.y : minCenterY

    const labelLeft = labelX - halfWidth
    const labelRight = labelX + halfWidth
    const labelTop = labelY - halfHeight
    const labelBottom = labelY + halfHeight
    const lineX = Math.min(Math.max(anchorX, labelLeft), labelRight)
    const lineY = Math.min(Math.max(anchorY, labelTop), labelBottom)
    const leader =
      Math.abs(lineX - anchorX) > 0.5 || Math.abs(lineY - anchorY) > 0.5
        ? [
            {
              type: 'line' as const,
              shape: {
                x1: anchorX,
                y1: anchorY,
                x2: lineX,
                y2: lineY,
              },
              style: {
                stroke: palette.borderStrong,
                lineWidth: 1,
              },
            },
          ]
        : []

    return {
      type: 'group',
      children: [
        ...leader,
        {
          type: 'rect',
          shape: {
            x: labelX - halfWidth,
            y: labelY - boxHeight / 2,
            width: boxWidth,
            height: boxHeight,
            r: 4,
          },
          style: {
            fill: palette.panel,
            stroke: palette.borderStrong,
            lineWidth: 1,
          },
        },
        {
          type: 'text',
          style: {
            text,
            x: labelX,
            y: labelY,
            align: 'center',
            verticalAlign: 'middle',
            fill: palette.text1,
            font,
          },
        },
      ],
    }
  }

  const option: echarts.EChartsOption = {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: { show: false },
    geo: [
      {
        map: MAINLAND_MAP_NAME,
        boundingCoords: MAINLAND_BOUNDS,
        preserveAspect: true,
        roam: false,
        silent: false,
        selectedMode: false,
        aspectScale: 0.75,
        left: 4,
        right: 4,
        top: 4,
        bottom: 4,
        label: { show: false },
        itemStyle: {
          areaColor: palette.land,
          borderColor: palette.border,
          borderWidth: 1,
        },
        emphasis: {
          label: { show: false },
          itemStyle: {
            areaColor: palette.hover,
            borderColor: palette.selectedBorder,
            borderWidth: 1,
          },
        },
        regions: [
          {
            name: '香港',
            silent: true,
            itemStyle: { areaColor: palette.off, borderColor: palette.border, borderWidth: 1 },
            emphasis: { itemStyle: { areaColor: palette.off } },
          },
          {
            name: '澳门',
            silent: true,
            itemStyle: { areaColor: palette.off, borderColor: palette.border, borderWidth: 1 },
            emphasis: { itemStyle: { areaColor: palette.off } },
          },
          ...(selected
            ? [
                {
                  name: selected,
                  itemStyle: {
                    areaColor: palette.selectedFill,
                    borderColor: palette.selectedBorder,
                    borderWidth: 1.5,
                  },
                  emphasis: {
                    itemStyle: {
                      areaColor: palette.selectedFill,
                      borderColor: palette.selectedBorder,
                      borderWidth: 1.5,
                    },
                  },
                },
              ]
            : []),
        ],
      },
      {
        map: SOUTH_SEA_MAP_NAME,
        preserveAspect: true,
        layoutCenter: INSET_CENTER,
        layoutSize: INSET_SIZE,
        roam: false,
        silent: true,
        selectedMode: false,
        label: { show: false },
        itemStyle: {
          areaColor: palette.off,
          borderColor: palette.borderStrong,
          borderWidth: 1,
        },
      },
    ],
    series: [
      {
        type: 'custom',
        coordinateSystem: 'geo',
        geoIndex: 0,
        silent: true,
        clip: false,
        z: 5,
        data: entries.map((entry) => ({
          name: entry.name,
          value: [entry.centroid[0], entry.centroid[1], entry.value ?? 0],
        })),
        renderItem: renderColumns,
      },
      {
        type: 'custom',
        coordinateSystem: 'geo',
        geoIndex: 0,
        silent: true,
        clip: false,
        z: 20,
        data: selectedEntry
          ? [
              {
                name: selectedEntry.name,
                value: [selectedEntry.centroid[0], selectedEntry.centroid[1], selectedEntry.value ?? 0],
              },
            ]
          : [],
        renderItem: renderSelectedLabel,
      },
    ],
  }

  return option
}

export function ChinaMap({ data, selected, onSelect, theme }: ChinaMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartHostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const hitAreasRef = useRef<Array<HitArea | undefined>>([])
  const onSelectRef = useRef(onSelect)
  const hoverNameRef = useRef<string | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  const entries = useMemo<ColumnEntry[]>(() => {
    const values = new Map<string, number>()
    for (const datum of data) {
      values.set(shortProvinceName(datum.name), datum.value)
    }
    const list: ColumnEntry[] = []
    for (const name of REGION_ORDER) {
      const centroid = REGION_CENTROIDS[name]
      if (!centroid) continue
      const value = values.get(name)
      list.push({
        name,
        value: value === undefined ? null : value,
        centroid,
        offset: REGION_OFFSETS[name] ?? [0, 0],
      })
    }
    return list
  }, [data])

  const maxValue = useMemo(() => {
    let max = 0
    for (const entry of entries) {
      if (entry.value !== null && entry.value > max) max = entry.value
    }
    return max
  }, [entries])

  const valueByName = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const entry of entries) map.set(entry.name, entry.value)
    return map
  }, [entries])

  const ariaLabel = useMemo(() => {
    const counted = entries.filter((entry) => entry.value !== null)
    if (counted.length === 0) {
      return `中国地图：演示数据 ${DEMO_DATE}，今日暂无分拣统计数据。32 个省级地区参与统计，港澳不参与统计。`
    }
    let total = 0
    let top = counted[0]
    for (const entry of counted) {
      total += entry.value ?? 0
      if ((entry.value ?? 0) > (top.value ?? 0)) top = entry
    }
    return `中国地图：演示数据，统计日期 ${DEMO_DATE}，今日分拣合计 ${formatInteger(total)} 件，${top.name}最高 ${formatInteger(
      top.value,
    )} 件。32 个省级地区参与统计，港澳不参与统计。点击省份或立体柱可选中地区。`
  }, [entries])

  // 初始化图表、事件与尺寸监听（只在挂载时执行一次）。
  useEffect(() => {
    const container = containerRef.current
    const host = chartHostRef.current
    if (!container || !host) return undefined

    registerChinaMap()
    registerMainlandMap()
    registerSouthSeaMap()
    const chart = echarts.init(host, undefined, {
      renderer: 'canvas',
      devicePixelRatio: typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    })
    chartRef.current = chart

    const zr = chart.getZr()
    let frame = 0

    const resolveRegionAt = (x: number, y: number): string | null => {
      if (isInsideSouthSeaInset(chart, x, y)) return null
      const areas = hitAreasRef.current
      for (let index = areas.length - 1; index >= 0; index -= 1) {
        const area = areas[index]
        if (area && x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2) {
          return area.name
        }
      }
      const point = chart.convertFromPixel({ geoIndex: 0 }, [x, y]) as number[] | undefined
      if (!point || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return null
      }
      return findRegionAt(point[0], point[1])
    }

    const handleMove = (event: unknown) => {
      if (frame) return
      const { offsetX, offsetY } = event as { offsetX: number; offsetY: number }
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const rawName = resolveRegionAt(offsetX, offsetY)
        const name = rawName && isStatRegion(rawName) ? rawName : null
        if (name === hoverNameRef.current) return
        hoverNameRef.current = name
        zr.setCursorStyle(name ? 'pointer' : 'default')
        if (!name) {
          setHover(null)
          return
        }
        const width = container.clientWidth
        const height = container.clientHeight
        const left = Math.min(Math.max(8, offsetX + 14), Math.max(8, width - TOOLTIP_WIDTH - 8))
        const top = Math.min(Math.max(8, offsetY + 14), Math.max(8, height - TOOLTIP_HEIGHT - 8))
        setHover({ name, x: left, y: top })
      })
    }

    const handleLeave = () => {
      if (frame) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
      hoverNameRef.current = null
      zr.setCursorStyle('default')
      setHover(null)
    }

    const handleClick = (event: unknown) => {
      const { offsetX, offsetY } = event as { offsetX: number; offsetY: number }
      const rawName = resolveRegionAt(offsetX, offsetY)
      onSelectRef.current(rawName && isStatRegion(rawName) ? rawName : null)
    }

    zr.on('mousemove', handleMove)
    zr.on('globalout', handleLeave)
    zr.on('click', handleClick)

    const observer = new ResizeObserver(() => {
      chart.resize({ animation: { duration: 0 } })
    })
    observer.observe(host)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      zr.off('mousemove', handleMove)
      zr.off('globalout', handleLeave)
      zr.off('click', handleClick)
      chart.dispose()
      chartRef.current = null
      hitAreasRef.current = []
      hoverNameRef.current = null
      host.style.cursor = ''
    }
  }, [])

  // 数据、选中项或主题变化时更新图表。
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const palette = resolvePalette(theme)
    const boxes: Array<HitArea | undefined> = []
    hitAreasRef.current = boxes
    chart.setOption(buildMapOption(entries, maxValue, selected, palette, boxes), {
      notMerge: true,
      lazyUpdate: false,
    })
  }, [entries, maxValue, selected, theme])

  return (
    <div
      ref={containerRef}
      className="map-canvas"
      role="img"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected) onSelect(null)
      }}
    >
      <div ref={chartHostRef} className="map-canvas__chart" aria-hidden="true" />
      {hover ? (
        <div className="map-tip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.name}</strong>
          <span>{valueText(valueByName.get(hover.name))}</span>
          <span>统计日期 {DEMO_DATE}</span>
        </div>
      ) : null}
    </div>
  )
}
