import * as echarts from 'echarts'
import chinaGeoRaw from '../assets/china.geo.json'
import { DEMO_REGION_NAMES } from './demo'

type Position = [number, number]
type Ring = Position[]

interface GeoFeature {
  type: 'Feature'
  properties: {
    name?: string
    adcode?: string | number
    [key: string]: unknown
  }
  geometry:
    | { type: 'Polygon'; coordinates: Ring[] }
    | { type: 'MultiPolygon'; coordinates: Ring[][] }
}

interface GeoCollection {
  type: 'FeatureCollection'
  features: GeoFeature[]
}

const SHORT_NAMES: Record<string, string> = {
  北京市: '北京',
  天津市: '天津',
  河北省: '河北',
  山西省: '山西',
  内蒙古自治区: '内蒙古',
  辽宁省: '辽宁',
  吉林省: '吉林',
  黑龙江省: '黑龙江',
  上海市: '上海',
  江苏省: '江苏',
  浙江省: '浙江',
  安徽省: '安徽',
  福建省: '福建',
  江西省: '江西',
  山东省: '山东',
  河南省: '河南',
  湖北省: '湖北',
  湖南省: '湖南',
  广东省: '广东',
  广西壮族自治区: '广西',
  海南省: '海南',
  重庆市: '重庆',
  四川省: '四川',
  贵州省: '贵州',
  云南省: '云南',
  西藏自治区: '西藏',
  陕西省: '陕西',
  甘肃省: '甘肃',
  青海省: '青海',
  宁夏回族自治区: '宁夏',
  新疆维吾尔自治区: '新疆',
  台湾省: '台湾',
  香港特别行政区: '香港',
  澳门特别行政区: '澳门',
}

export function shortProvinceName(name: string): string {
  if (!name) return ''
  return SHORT_NAMES[name] ?? name.replace(/(省|市)$/, '')
}

const rawCollection = chinaGeoRaw as unknown as GeoCollection

export const CHINA_GEOJSON: GeoCollection = {
  ...rawCollection,
  features: rawCollection.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      name: shortProvinceName(String(feature.properties.name ?? '')),
    },
  })),
}

export const ALL_MAP_REGION_NAMES = new Set(
  CHINA_GEOJSON.features.map((feature) => feature.properties.name).filter(Boolean) as string[],
)

export const STAT_REGION_NAMES = DEMO_REGION_NAMES

export function isStatRegion(name: string): boolean {
  return DEMO_REGION_NAMES.has(name)
}

function outerRings(feature: GeoFeature): Ring[] {
  if (feature.geometry.type === 'Polygon') {
    return feature.geometry.coordinates.length > 0 ? [feature.geometry.coordinates[0]] : []
  }
  return feature.geometry.coordinates.map((polygon) => polygon[0]).filter(Boolean)
}

function ringBBoxArea(ring: Ring): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
}

function ringCenter(ring: Ring): Position {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

export const REGION_CENTROIDS: Record<string, Position> = (() => {
  const result: Record<string, Position> = {}
  for (const feature of CHINA_GEOJSON.features) {
    const name = feature.properties.name
    if (!name) continue
    const rings = outerRings(feature)
    if (!rings.length) continue
    let largest = rings[0]
    let largestArea = ringBBoxArea(largest)
    for (const ring of rings.slice(1)) {
      const area = ringBBoxArea(ring)
      if (area > largestArea) {
        largest = ring
        largestArea = area
      }
    }
    result[name] = ringCenter(largest)
  }
  return result
})()

function pointInRing(point: Position, ring: Ring): boolean {
  let inside = false
  const [x, y] = point
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function findRegionAt(lng: number, lat: number): string | null {
  const point: Position = [lng, lat]
  for (const feature of CHINA_GEOJSON.features) {
    const name = feature.properties.name
    if (!name) continue
    const rings = outerRings(feature)
    for (const ring of rings) {
      if (pointInRing(point, ring)) return name
    }
  }
  return null
}

let registered = false

export function registerChinaMap(): void {
  if (registered) return
  echarts.registerMap('china', CHINA_GEOJSON as never)
  registered = true
}

export const GEO_ATTRIBUTION = 'DataV.GeoAtlas 100000_full'
