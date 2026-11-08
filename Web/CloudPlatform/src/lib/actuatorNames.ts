import { useCallback, useState } from 'react'

export type ActuatorNameKey = 'fan' | 'light' | 'alarm' | 'gate' | 'traffic'

export type ActuatorNames = Record<ActuatorNameKey, string>

export const DEFAULT_ACTUATOR_NAMES: ActuatorNames = {
  fan: '风扇',
  light: '照明',
  alarm: '烟雾报警',
  gate: '大门',
  traffic: '三色灯',
}

const STORAGE_KEY = 'yx.actuatorNames.v1'
const MAX_NAME_LENGTH = 16

function readNames(): ActuatorNames {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_ACTUATOR_NAMES
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_ACTUATOR_NAMES
    const record = parsed as Record<string, unknown>
    const names = { ...DEFAULT_ACTUATOR_NAMES }
    for (const key of Object.keys(names) as ActuatorNameKey[]) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) names[key] = value.trim().slice(0, MAX_NAME_LENGTH)
    }
    return names
  } catch {
    return DEFAULT_ACTUATOR_NAMES
  }
}

export function useActuatorNames() {
  const [names, setNames] = useState<ActuatorNames>(readNames)

  const rename = useCallback((key: ActuatorNameKey, next: string) => {
    const value = next.trim().slice(0, MAX_NAME_LENGTH)
    if (!value) return
    setNames((previous) => {
      if (previous[key] === value) return previous
      const updated = { ...previous, [key]: value }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // 本地存储不可用时仍保留本次会话命名。
      }
      return updated
    })
  }, [])

  return { names, rename }
}
