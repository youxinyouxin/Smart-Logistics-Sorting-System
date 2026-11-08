import { useCallback, useState } from 'react'

export interface DeviceLayout {
  width: number
  height: number
  gap: number
}

export const DEVICE_LAYOUT_LIMITS = {
  width: { min: 150, max: 300, step: 10, fallback: 170 },
  height: { min: 128, max: 280, step: 2, fallback: 128 },
  gap: { min: 4, max: 32, step: 2, fallback: 12 },
} as const

export const DEFAULT_DEVICE_LAYOUT: DeviceLayout = {
  width: DEVICE_LAYOUT_LIMITS.width.fallback,
  height: DEVICE_LAYOUT_LIMITS.height.fallback,
  gap: DEVICE_LAYOUT_LIMITS.gap.fallback,
}

const STORAGE_KEY = 'yx.deviceLayout.v1'

function readNumber(value: unknown, limits: { min: number; max: number; fallback: number }): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return limits.fallback
  return Math.min(limits.max, Math.max(limits.min, Math.round(parsed)))
}

function readLayout(): DeviceLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_DEVICE_LAYOUT
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_DEVICE_LAYOUT
    const record = parsed as Record<string, unknown>
    return {
      width: readNumber(record.width, DEVICE_LAYOUT_LIMITS.width),
      height: readNumber(record.height, DEVICE_LAYOUT_LIMITS.height),
      gap: readNumber(record.gap, DEVICE_LAYOUT_LIMITS.gap),
    }
  } catch {
    return DEFAULT_DEVICE_LAYOUT
  }
}

function sameAsDefault(layout: DeviceLayout): boolean {
  return (
    layout.width === DEFAULT_DEVICE_LAYOUT.width &&
    layout.height === DEFAULT_DEVICE_LAYOUT.height &&
    layout.gap === DEFAULT_DEVICE_LAYOUT.gap
  )
}

export function useDeviceLayout() {
  const [layout, setLayout] = useState<DeviceLayout>(readLayout)

  const updateLayout = useCallback((patch: Partial<DeviceLayout>) => {
    setLayout((previous) => {
      const updated = {
        width: readNumber(patch.width ?? previous.width, DEVICE_LAYOUT_LIMITS.width),
        height: readNumber(patch.height ?? previous.height, DEVICE_LAYOUT_LIMITS.height),
        gap: readNumber(patch.gap ?? previous.gap, DEVICE_LAYOUT_LIMITS.gap),
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // 本地存储不可用时仍保留本次会话布局。
      }
      return updated
    })
  }, [])

  const resetLayout = useCallback(() => {
    setLayout(DEFAULT_DEVICE_LAYOUT)
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 忽略本地存储不可用。
    }
  }, [])

  return { layout, updateLayout, resetLayout, isDefault: sameAsDefault(layout) }
}
