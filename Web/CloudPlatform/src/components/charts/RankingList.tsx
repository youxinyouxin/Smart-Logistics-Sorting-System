import { useEffect, useMemo, useRef, useState } from 'react'
import { STAT_REGION_NAMES, shortProvinceName } from '../../lib/china'
import { formatInteger, formatPercent } from '../../lib/format'
import type { RegionDatum } from '../../types'
import { Badge } from '../ui/Badge'
import '../../styles/map.css'

export interface RankingListProps {
  data: RegionDatum[]
  total: number
  selected: string | null
  onSelect: (name: string | null) => void
  demo?: boolean
}

const COLLAPSED_ROWS = 8

interface RankRow {
  rank: number
  name: string
  value: number | null
}

export function RankingList({ data, total, selected, onSelect, demo = false }: RankingListProps) {
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const rows = useMemo<RankRow[]>(() => {
    if (data.length === 0) return []
    const values = new Map<string, number>()
    for (const datum of data) {
      values.set(shortProvinceName(datum.name), datum.value)
    }
    const merged = Array.from(STAT_REGION_NAMES).map((name) => ({
      name,
      value: values.has(name) ? (values.get(name) as number) : null,
    }))
    merged.sort((a, b) => {
      if (a.value === null && b.value === null) return a.name.localeCompare(b.name, 'zh-CN')
      if (a.value === null) return 1
      if (b.value === null) return -1
      if (a.value !== b.value) return b.value - a.value
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return merged.map((row, index) => ({ ...row, rank: index + 1 }))
  }, [data])

  const hasData = rows.length > 0
  const visibleRows = expanded ? rows : rows.slice(0, COLLAPSED_ROWS)

  // 从地图选中排名 9 名以后的地区时，展开列表以便看到高亮行。
  useEffect(() => {
    if (!selected) return
    const index = rows.findIndex((row) => row.name === selected)
    if (index >= COLLAPSED_ROWS) setExpanded(true)
  }, [selected, rows])

  useEffect(() => {
    if (!selected) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-region="${selected}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [selected, expanded, rows])

  const handleRowSelect = (name: string) => {
    onSelect(selected === name ? null : name)
  }

  return (
    <section className="panel ranking-panel ranking-panel--chart" aria-label="地区排行">
      <div className="ranking-panel__head">
        <h3 className="panel__title">地区排行</h3>
        {demo ? <Badge tone="demo">演示</Badge> : null}
        {hasData ? <span className="ranking-panel__count">合计 {formatInteger(total)} 件</span> : null}
      </div>
      {hasData ? (
        <>
          <div className="ranking-list" ref={listRef}>
            {visibleRows.map((row) => {
              const isSelected = selected === row.name
              const missing = row.value === null
              return (
                <button
                  key={row.name}
                  type="button"
                  className={`ranking-row${isSelected ? ' ranking-row--selected' : ''}`}
                  data-region={row.name}
                  aria-pressed={isSelected}
                  onClick={() => handleRowSelect(row.name)}
                >
                  <span className="ranking-row__index num">{row.rank}</span>
                  <span className="ranking-row__name">{row.name}</span>
                  <span
                    className={`ranking-row__value${missing ? ' ranking-row__value--missing' : ''}`}
                  >
                    {missing ? '—' : `${formatInteger(row.value)} 件`}
                  </span>
                  <span
                    className={`ranking-row__share${missing ? ' ranking-row__share--missing' : ''}`}
                  >
                    {missing ? '—' : formatPercent(row.value ?? 0, total)}
                  </span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="ranking-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? `收起，仅显示前 ${COLLAPSED_ROWS} 个地区` : `查看全部 ${rows.length} 个地区`}
          </button>
        </>
      ) : (
        <p className="ranking-empty">今日暂无分拣统计数据</p>
      )}
    </section>
  )
}
