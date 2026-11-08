import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppSettings, AppearanceSettings } from '../types'
import { normalizeApiBase } from './api'
import { DEFAULT_SORTER_API_BASE, normalizeSorterBase } from './sorterApi'

export const SETTINGS_STORAGE_KEY = 'yx.settings.v1'

export const DEFAULT_SETTINGS: AppSettings = {
  thresholds: {
    tempMin: null,
    tempMax: null,
    humidityMin: null,
    humidityMax: null,
    pm25GoodMax: 35,
    pm25MidMax: 75,
    pm25DisplayMax: 150,
    co2Max: null,
    tvocMax: null,
    lightMax: null,
  },
  appearance: {
    theme: 'light',
    fontScale: 'standard',
    density: 'comfortable',
  },
  refresh: {
    pollIntervalMs: 5000,
    rulePollIntervalMs: 2000,
    chartWindowMinutes: 60,
    showSeconds: true,
    decimals: 1,
  },
  apiBaseUrl: '/api',
  sorterApiBaseUrl: DEFAULT_SORTER_API_BASE,
}

export function applyAppearance(appearance: AppearanceSettings): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = appearance.theme
  document.documentElement.dataset.fontScale = appearance.fontScale
  document.documentElement.dataset.density = appearance.density
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) themeMeta.setAttribute('content', appearance.theme === 'dark' ? '#14181D' : '#F4F5F7')
}

function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const stored = JSON.parse(raw) as Partial<AppSettings>
    return {
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(stored.thresholds ?? {}) },
      appearance: { ...DEFAULT_SETTINGS.appearance, ...(stored.appearance ?? {}) },
      refresh: { ...DEFAULT_SETTINGS.refresh, ...(stored.refresh ?? {}) },
      apiBaseUrl: normalizeApiBase(stored.apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl),
      sorterApiBaseUrl: normalizeSorterBase(
        stored.sorterApiBaseUrl ?? DEFAULT_SETTINGS.sorterApiBaseUrl,
      ),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

interface SettingsContextValue {
  settings: AppSettings
  saveSettings: (next: AppSettings) => void
  resetSettings: () => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings)

  useEffect(() => {
    applyAppearance(settings.appearance)
  }, [settings.appearance])

  useEffect(() => {
    document.documentElement.dataset.showSeconds = settings.refresh.showSeconds ? 'true' : 'false'
  }, [settings.refresh.showSeconds])

  const saveSettings = useCallback((next: AppSettings) => {
    const normalized: AppSettings = {
      ...next,
      apiBaseUrl: normalizeApiBase(next.apiBaseUrl),
      sorterApiBaseUrl: normalizeSorterBase(next.sorterApiBaseUrl),
      thresholds: { ...next.thresholds },
      appearance: { ...next.appearance },
      refresh: { ...next.refresh },
    }
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
    setSettings(normalized)
    applyAppearance(normalized.appearance)
  }, [])

  const resetSettings = useCallback(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS))
    setSettings(DEFAULT_SETTINGS)
    applyAppearance(DEFAULT_SETTINGS.appearance)
  }, [])

  const value = useMemo(
    () => ({ settings, saveSettings, resetSettings }),
    [settings, saveSettings, resetSettings],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettings must be used inside SettingsProvider')
  return context
}
