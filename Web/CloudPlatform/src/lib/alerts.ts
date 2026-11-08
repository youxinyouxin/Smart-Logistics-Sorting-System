import type { EnvAlert, SourceKey, SourceSnapshot, Thresholds } from '../types'
import { formatDecimal, parseNumeric } from './format'

function valueOf(source: SourceSnapshot, field: string): number | null {
  return parseNumeric(source.values[field])
}

export function getSourceAlerts(
  _sourceKey: SourceKey,
  source: SourceSnapshot | undefined,
  thresholds: Thresholds,
  stale: boolean,
): EnvAlert[] {
  if (!source || stale) return []
  const alerts: EnvAlert[] = []
  const temperature = valueOf(source, 'temperature')
  const humidity = valueOf(source, 'humidity')
  const pm25 = valueOf(source, 'pm2_5')
  const co2 = valueOf(source, 'co2')
  const tvoc = valueOf(source, 'tvoc')
  const illumination = valueOf(source, 'illumination')

  if (temperature !== null && thresholds.tempMax !== null && temperature > thresholds.tempMax) {
    alerts.push({
      metric: '温度',
      level: 'danger',
      message: `温度 ${formatDecimal(temperature, 1)} °C，高于上限 ${formatDecimal(thresholds.tempMax, 1)} °C`,
    })
  }
  if (temperature !== null && thresholds.tempMin !== null && temperature < thresholds.tempMin) {
    alerts.push({
      metric: '温度',
      level: 'danger',
      message: `温度 ${formatDecimal(temperature, 1)} °C，低于下限 ${formatDecimal(thresholds.tempMin, 1)} °C`,
    })
  }
  if (humidity !== null && thresholds.humidityMax !== null && humidity > thresholds.humidityMax) {
    alerts.push({
      metric: '湿度',
      level: 'warn',
      message: `湿度 ${formatDecimal(humidity, 1)} %RH，高于上限 ${formatDecimal(thresholds.humidityMax, 0)} %RH`,
    })
  }
  if (humidity !== null && thresholds.humidityMin !== null && humidity < thresholds.humidityMin) {
    alerts.push({
      metric: '湿度',
      level: 'warn',
      message: `湿度 ${formatDecimal(humidity, 1)} %RH，低于下限 ${formatDecimal(thresholds.humidityMin, 0)} %RH`,
    })
  }
  if (pm25 !== null && pm25 > thresholds.pm25MidMax) {
    alerts.push({ metric: 'PM2.5', level: 'danger', message: `PM2.5 ${Math.round(pm25)} μg/m³，超过 ${thresholds.pm25MidMax} 分级阈值` })
  }
  if (co2 !== null && thresholds.co2Max !== null && co2 > thresholds.co2Max) {
    alerts.push({ metric: 'CO₂', level: 'warn', message: `CO₂ ${Math.round(co2)} ppm，高于上限 ${thresholds.co2Max} ppm` })
  }
  if (tvoc !== null && thresholds.tvocMax !== null && tvoc > thresholds.tvocMax) {
    alerts.push({ metric: 'TVOC', level: 'warn', message: `TVOC ${Math.round(tvoc)} ppb，高于上限 ${thresholds.tvocMax} ppb` })
  }
  if (illumination !== null && thresholds.lightMax !== null && illumination > thresholds.lightMax) {
    alerts.push({ metric: '光照', level: 'warn', message: `光照 ${Math.round(illumination)} lx，高于上限 ${thresholds.lightMax} lx` })
  }

  return alerts
}
