import type { RegionDatum } from '../types'

export const DEMO_DATE = '2026-11-03'

export const DEMO_REGIONS: RegionDatum[] = [
  { name: '广东', value: 186 },
  { name: '浙江', value: 142 },
  { name: '江苏', value: 128 },
  { name: '上海', value: 96 },
  { name: '北京', value: 82 },
  { name: '山东', value: 74 },
  { name: '福建', value: 61 },
  { name: '河南', value: 55 },
  { name: '四川', value: 48 },
  { name: '湖北', value: 43 },
  { name: '湖南', value: 39 },
  { name: '安徽', value: 36 },
  { name: '河北', value: 33 },
  { name: '江西', value: 28 },
  { name: '陕西', value: 24 },
  { name: '辽宁', value: 21 },
  { name: '重庆', value: 19 },
  { name: '天津', value: 16 },
  { name: '广西', value: 14 },
  { name: '云南', value: 12 },
  { name: '山西', value: 10 },
  { name: '贵州', value: 8 },
  { name: '黑龙江', value: 7 },
  { name: '吉林', value: 6 },
  { name: '内蒙古', value: 5 },
  { name: '甘肃', value: 4 },
  { name: '新疆', value: 3 },
  { name: '海南', value: 2 },
  { name: '宁夏', value: 2 },
  { name: '青海', value: 1 },
  { name: '西藏', value: 0 },
  { name: '台湾', value: 0 },
]

export const DEMO_REGION_NAMES = new Set(DEMO_REGIONS.map((region) => region.name))
export const DEMO_TOTAL = DEMO_REGIONS.reduce((sum, region) => sum + region.value, 0)

export function getDemoRanking(): RegionDatum[] {
  return [...DEMO_REGIONS].sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export function regionValue(name: string): number | undefined {
  return DEMO_REGIONS.find((region) => region.name === name)?.value
}
