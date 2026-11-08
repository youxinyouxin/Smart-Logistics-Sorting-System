import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { FormField } from '../components/ui/FormField'
import { Modal } from '../components/ui/Overlay'
import { Segmented } from '../components/ui/Segmented'
import { useToast } from '../components/ui/Toast'
import { ApiError, errorMessage, normalizeApiBase, testConnection } from '../lib/api'
import { normalizeSorterBase } from '../lib/sorterApi'
import { formatClock } from '../lib/format'
import { applyAppearance, DEFAULT_SETTINGS, useSettings } from '../lib/settings'
import { useMediaQuery } from '../lib/useMediaQuery'
import type { AppSettings, AppearanceSettings, RefreshSettings, Thresholds } from '../types'
import '../styles/settings.css'

type ThresholdDraftKey =
  | 'tempMin'
  | 'tempMax'
  | 'humidityMin'
  | 'humidityMax'
  | 'pm25GoodMax'
  | 'pm25MidMax'
  | 'pm25DisplayMax'
  | 'co2Max'
  | 'tvocMax'
  | 'lightMax'

type ThresholdDraft = Record<ThresholdDraftKey, string>
type FieldKey = ThresholdDraftKey | 'apiBaseUrl' | 'sorterApiBaseUrl'

interface DraftSettings {
  thresholds: ThresholdDraft
  appearance: AppearanceSettings
  refresh: RefreshSettings
  apiBaseUrl: string
  sorterApiBaseUrl: string
}

interface DraftValidation {
  errors: Partial<Record<FieldKey, string>>
  warnings: Partial<Record<FieldKey, string>>
  settings: AppSettings | null
  errorCount: number
}

type TestState =
  | { status: 'ok'; base: string; elapsedMs: number; sourceCount: number; at: number }
  | { status: 'error'; base: string; message: string; at: number }

const THRESHOLD_KEYS: ThresholdDraftKey[] = [
  'tempMin',
  'tempMax',
  'humidityMin',
  'humidityMax',
  'pm25GoodMax',
  'pm25MidMax',
  'pm25DisplayMax',
  'co2Max',
  'tvocMax',
  'lightMax',
]

const THEME_OPTIONS: Array<{ value: AppearanceSettings['theme']; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const FONT_OPTIONS: Array<{ value: AppearanceSettings['fontScale']; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大字号' },
]

const DENSITY_OPTIONS: Array<{ value: AppearanceSettings['density']; label: string }> = [
  { value: 'comfortable', label: '宽松' },
  { value: 'compact', label: '标准' },
]

const POLL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '5000', label: '5 秒' },
  { value: '10000', label: '10 秒' },
  { value: '30000', label: '30 秒' },
  { value: '60000', label: '60 秒' },
]

const RULE_POLL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1000', label: '1 秒' },
  { value: '2000', label: '2 秒' },
  { value: '3000', label: '3 秒' },
  { value: '5000', label: '5 秒' },
]

const SECONDS_OPTIONS: Array<{ value: 'on' | 'off'; label: string }> = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
]

const DECIMALS_OPTIONS: Array<{ value: '0' | '1' | '2'; label: string }> = [
  { value: '0', label: '0 位' },
  { value: '1', label: '1 位' },
  { value: '2', label: '2 位' },
]

const TEMPERATURE_PATTERN = /^-?\d+(\.\d)?$/
const INTEGER_PATTERN = /^\d+$/

function numberText(value: number | null): string {
  return value === null ? '' : String(value)
}

function draftFromSettings(settings: AppSettings): DraftSettings {
  return {
    thresholds: {
      tempMin: numberText(settings.thresholds.tempMin),
      tempMax: numberText(settings.thresholds.tempMax),
      humidityMin: numberText(settings.thresholds.humidityMin),
      humidityMax: numberText(settings.thresholds.humidityMax),
      pm25GoodMax: numberText(settings.thresholds.pm25GoodMax),
      pm25MidMax: numberText(settings.thresholds.pm25MidMax),
      pm25DisplayMax: numberText(settings.thresholds.pm25DisplayMax),
      co2Max: numberText(settings.thresholds.co2Max),
      tvocMax: numberText(settings.thresholds.tvocMax),
      lightMax: numberText(settings.thresholds.lightMax),
    },
    appearance: { ...settings.appearance },
    refresh: { ...settings.refresh },
    apiBaseUrl: settings.apiBaseUrl,
    sorterApiBaseUrl: settings.sorterApiBaseUrl,
  }
}

function thresholdsEqual(draft: ThresholdDraft, saved: Thresholds): boolean {
  for (const key of THRESHOLD_KEYS) {
    const raw = draft[key].trim()
    const savedValue = saved[key]
    if (raw === '') {
      if (savedValue !== null) return false
      continue
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value !== savedValue) return false
  }
  return true
}

function draftEqualsSaved(draft: DraftSettings, saved: AppSettings): boolean {
  return (
    thresholdsEqual(draft.thresholds, saved.thresholds) &&
    draft.appearance.theme === saved.appearance.theme &&
    draft.appearance.fontScale === saved.appearance.fontScale &&
    draft.appearance.density === saved.appearance.density &&
    draft.refresh.pollIntervalMs === saved.refresh.pollIntervalMs &&
    draft.refresh.rulePollIntervalMs === saved.refresh.rulePollIntervalMs &&
    draft.refresh.chartWindowMinutes === saved.refresh.chartWindowMinutes &&
    draft.refresh.showSeconds === saved.refresh.showSeconds &&
    draft.refresh.decimals === saved.refresh.decimals &&
    draft.apiBaseUrl.trim() === saved.apiBaseUrl &&
    draft.sorterApiBaseUrl.trim() === saved.sorterApiBaseUrl
  )
}

function validateDraft(draft: DraftSettings): DraftValidation {
  const errors: Partial<Record<FieldKey, string>> = {}
  const warnings: Partial<Record<FieldKey, string>> = {}

  const parseOptional = (
    key: ThresholdDraftKey,
    pattern: RegExp,
    min: number,
    max: number,
    message: string,
  ): number | null => {
    const raw = draft.thresholds[key].trim()
    if (raw === '') return null
    const value = Number(raw)
    if (!pattern.test(raw) || !Number.isFinite(value) || value < min || value > max) {
      errors[key] = message
      return null
    }
    return value
  }

  const parseRequired = (
    key: ThresholdDraftKey,
    pattern: RegExp,
    min: number,
    max: number,
    emptyMessage: string,
    invalidMessage: string,
  ): number | null => {
    const raw = draft.thresholds[key].trim()
    if (raw === '') {
      errors[key] = emptyMessage
      return null
    }
    const value = Number(raw)
    if (!pattern.test(raw) || !Number.isFinite(value) || value < min || value > max) {
      errors[key] = invalidMessage
      return null
    }
    return value
  }

  const tempMin = parseOptional(
    'tempMin',
    TEMPERATURE_PATTERN,
    -10,
    59,
    '温度下限需在 −10.0–59.0 ℃ 之间，最多 1 位小数',
  )
  const tempMax = parseOptional(
    'tempMax',
    TEMPERATURE_PATTERN,
    -9,
    60,
    '温度上限需在 −9.0–60.0 ℃ 之间，最多 1 位小数',
  )
  if (tempMin !== null && tempMax !== null && tempMax - tempMin < 1) {
    const message = '温度下限必须低于上限，且至少相差 1.0 ℃'
    errors.tempMin = message
    errors.tempMax = message
  }

  const humidityMin = parseOptional(
    'humidityMin',
    INTEGER_PATTERN,
    0,
    99,
    '湿度下限需在 0–99 %RH 之间（整数）',
  )
  const humidityMax = parseOptional(
    'humidityMax',
    INTEGER_PATTERN,
    1,
    100,
    '湿度上限需在 1–100 %RH 之间（整数）',
  )
  if (humidityMin !== null && humidityMax !== null && humidityMin >= humidityMax) {
    errors.humidityMin = '湿度下限必须低于上限'
    errors.humidityMax = '湿度下限必须低于上限'
  }

  const pm25GoodMax = parseRequired(
    'pm25GoodMax',
    INTEGER_PATTERN,
    1,
    499,
    '请填写 PM2.5 优上限（默认 35）',
    'PM2.5 优上限需在 1–499 μg/m³ 之间（整数）',
  )
  const pm25MidMax = parseRequired(
    'pm25MidMax',
    INTEGER_PATTERN,
    2,
    500,
    '请填写 PM2.5 良上限（默认 75）',
    'PM2.5 良上限需在 2–500 μg/m³ 之间（整数）',
  )
  const pm25DisplayMax = parseRequired(
    'pm25DisplayMax',
    INTEGER_PATTERN,
    50,
    500,
    '请填写显示量程上限（默认 150）',
    '显示量程上限需在 50–500 μg/m³ 之间（整数）',
  )
  if (pm25GoodMax !== null && pm25MidMax !== null && pm25GoodMax >= pm25MidMax) {
    errors.pm25GoodMax = 'PM2.5 优上限必须小于良上限'
    errors.pm25MidMax = 'PM2.5 良上限必须大于优上限'
  }
  if (pm25MidMax !== null && pm25DisplayMax !== null && pm25DisplayMax < pm25MidMax) {
    warnings.pm25DisplayMax = '量程上限低于良上限，仪表将无法显示超标区段'
  }

  const co2Max = parseOptional(
    'co2Max',
    INTEGER_PATTERN,
    400,
    5000,
    'CO₂ 上限需在 400–5000 ppm',
  )
  const tvocMax = parseOptional(
    'tvocMax',
    INTEGER_PATTERN,
    0,
    10000,
    'TVOC 上限需在 0–10000 ppb',
  )
  const lightMax = parseOptional(
    'lightMax',
    INTEGER_PATTERN,
    1,
    5000,
    '光照上限需在 1–5000 lx',
  )

  const rawBase = draft.apiBaseUrl.trim()
  if (!rawBase) {
    errors.apiBaseUrl = '请填写采集服务地址（/api 或 http://主机:端口/api）'
  } else if (rawBase.startsWith('//')) {
    errors.apiBaseUrl = '请使用 http:// 或 https:// 完整地址，或 /api 同源路径'
  } else if (/\s/.test(rawBase)) {
    errors.apiBaseUrl = '地址不能包含空格'
  } else if (/^https?:\/\//i.test(rawBase)) {
    try {
      const parsed = new URL(rawBase)
      if (!parsed.hostname) errors.apiBaseUrl = '地址格式不正确，例如 http://192.168.1.102:81/api'
    } catch {
      errors.apiBaseUrl = '地址格式不正确，例如 http://192.168.1.102:81/api'
    }
  } else if (!rawBase.startsWith('/')) {
    errors.apiBaseUrl = '只接受 /api 同源路径或 http://、https:// 完整地址'
  }
  if (
    !errors.apiBaseUrl &&
    /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(rawBase)
  ) {
    warnings.apiBaseUrl = '平板打开时会连接失败，请填后端主机的局域网地址（桌面调试可忽略）'
  }

  const rawSorterBase = draft.sorterApiBaseUrl.trim()
  if (!rawSorterBase) {
    errors.sorterApiBaseUrl = '请填写分拣服务地址（/sorter 或 http://主机:端口）'
  } else if (rawSorterBase.startsWith('//')) {
    errors.sorterApiBaseUrl = '请使用 http:// 或 https:// 完整地址，或同源路径'
  } else if (/\s/.test(rawSorterBase)) {
    errors.sorterApiBaseUrl = '地址不能包含空格'
  } else if (/^https?:\/\//i.test(rawSorterBase)) {
    try {
      const parsed = new URL(rawSorterBase)
      if (!parsed.hostname) errors.sorterApiBaseUrl = '地址格式不正确，例如 http://192.168.1.102:82'
    } catch {
      errors.sorterApiBaseUrl = '地址格式不正确，例如 http://192.168.1.102:82'
    }
  } else if (!rawSorterBase.startsWith('/')) {
    errors.sorterApiBaseUrl = '只接受同源路径或 http://、https:// 完整地址'
  }
  if (
    !errors.sorterApiBaseUrl &&
    /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(rawSorterBase)
  ) {
    warnings.sorterApiBaseUrl = '平板打开时会连接失败，请填分拣服务所在板子的局域网地址（桌面调试可忽略）'
  }

  const settings: AppSettings = {
    thresholds: {
      tempMin,
      tempMax,
      humidityMin,
      humidityMax,
      pm25GoodMax: pm25GoodMax ?? DEFAULT_SETTINGS.thresholds.pm25GoodMax,
      pm25MidMax: pm25MidMax ?? DEFAULT_SETTINGS.thresholds.pm25MidMax,
      pm25DisplayMax: pm25DisplayMax ?? DEFAULT_SETTINGS.thresholds.pm25DisplayMax,
      co2Max,
      tvocMax,
      lightMax,
    },
    appearance: { ...draft.appearance },
    refresh: { ...draft.refresh },
    apiBaseUrl: normalizeApiBase(rawBase),
    sorterApiBaseUrl: normalizeSorterBase(rawSorterBase),
  }
  const errorCount = Object.keys(errors).length

  return {
    errors,
    warnings,
    settings: errorCount === 0 ? settings : null,
    errorCount,
  }
}

function scrollFieldIntoView(event: FocusEvent<HTMLInputElement>) {
  if (!window.matchMedia('(pointer: coarse)').matches) return
  const target = event.currentTarget
  window.setTimeout(() => target.scrollIntoView({ block: 'center' }), 240)
}

interface SegmentedFieldProps {
  id: string
  label: string
  hint: string
  children: ReactNode
}

function SettingsGroup({
  id,
  title,
  description,
  open,
  onToggle,
  children,
}: {
  id: string
  title: string
  description: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className={`settings-group${open ? ' settings-group--open' : ''}`} aria-labelledby={id}>
      <button
        type="button"
        className="settings-group__toggle"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
      >
        <span className="settings-group__heading">
          <span className="settings-group__title" id={id}>
            {title}
          </span>
          <span className="settings-group__desc">{description}</span>
        </span>
        <ChevronDown size={20} className={`settings-group__chevron${open ? ' settings-group__chevron--open' : ''}`} aria-hidden="true" />
      </button>
      {open ? <div id={`${id}-body`}>{children}</div> : null}
    </section>
  )
}

function SegmentedField({ id, label, hint, children }: SegmentedFieldProps) {
  return (
    <div className="field" role="group" aria-labelledby={`${id}-label`}>
      <span className="field__label" id={`${id}-label`}>
        {label}
      </span>
      {children}
      <span className="field__hint">{hint}</span>
    </div>
  )
}

export function SettingsPage() {
  const { settings, saveSettings } = useSettings()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [draft, setDraft] = useState<DraftSettings>(() => draftFromSettings(settings))
  const [openGroups, setOpenGroups] = useState({
    thresholds: true,
    appearance: true,
    refresh: true,
    connection: true,
  })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [resetPending, setResetPending] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [testState, setTestState] = useState<TestState | null>(null)
  const [testing, setTesting] = useState(false)
  const [savebarOffset, setSavebarOffset] = useState(0)
  const mountedRef = useRef(true)
  const testAbortRef = useRef<AbortController | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const savedAppearanceRef = useRef<AppearanceSettings>(settings.appearance)
  const dirtyRef = useRef(false)

  const validation = useMemo(() => validateDraft(draft), [draft])
  const errorCount = validation.errorCount
  const dirty = useMemo(
    () => resetPending || !draftEqualsSaved(draft, settings),
    [draft, settings, resetPending],
  )
  dirtyRef.current = dirty
  const appearanceChanged =
    draft.appearance.theme !== settings.appearance.theme ||
    draft.appearance.fontScale !== settings.appearance.fontScale ||
    draft.appearance.density !== settings.appearance.density
  const draftBase = normalizeApiBase(draft.apiBaseUrl)
  const draftSorterBase = normalizeSorterBase(draft.sorterApiBaseUrl)

  useEffect(() => {
    savedAppearanceRef.current = settings.appearance
  }, [settings.appearance])

  useEffect(() => {
    setOpenGroups(
      isMobile
        ? { thresholds: true, appearance: false, refresh: false, connection: false }
        : { thresholds: true, appearance: true, refresh: true, connection: true },
    )
  }, [isMobile])

  const toggleGroup = (key: keyof typeof openGroups) => {
    setOpenGroups((previous) => ({ ...previous, [key]: !previous[key] }))
  }

  useEffect(() => {
    return () => {
      applyAppearance(savedAppearanceRef.current)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      testAbortRef.current?.abort()
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  useEffect(() => {
    const handleInternalLink = (event: MouseEvent) => {
      if (!dirtyRef.current) return
      const target = event.target instanceof Element ? event.target.closest('a') : null
      if (!(target instanceof HTMLAnchorElement)) return
      if (target.target === '_blank' || target.hasAttribute('download')) return
      const href = target.getAttribute('href')
      if (!href || !href.startsWith('/')) return
      event.preventDefault()
      setPendingPath(href)
    }
    document.addEventListener('click', handleInternalLink, true)
    return () => document.removeEventListener('click', handleInternalLink, true)
  }, [])

  const discardAndLeave = () => {
    applyAppearance(settings.appearance)
    setDraft(draftFromSettings(settings))
    setResetPending(false)
    setPendingPath(null)
    if (pendingPath) navigate(pendingPath)
  }

  const saveAndLeave = () => {
    if (errorCount > 0 || !validation.settings) return
    try {
      saveSettings(validation.settings)
      setDraft(draftFromSettings(validation.settings))
      setResetPending(false)
      savedAppearanceRef.current = validation.settings.appearance
      applyAppearance(validation.settings.appearance)
      const now = new Date()
      setSavedAt(now)
      showToast('已保存 · 仅本浏览器生效，正在离开', 'success')
      const target = pendingPath
      setPendingPath(null)
      if (target) navigate(target)
    } catch {
      setSaveError('保存失败：浏览器存储不可用，输入已保留，请重试或放弃修改')
    }
  }

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        setSavebarOffset(offset > 120 ? Math.round(offset) : 0)
      })
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      window.cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])

  const updateAppearance = (patch: Partial<AppearanceSettings>) => {
    const appearance = { ...draft.appearance, ...patch }
    setDraft({ ...draft, appearance })
    applyAppearance(appearance)
    setSaveError(null)
  }

  const updateRefresh = (patch: Partial<RefreshSettings>) => {
    setDraft((previous) => ({
      ...previous,
      refresh: { ...previous.refresh, ...patch },
    }))
    setSaveError(null)
  }

  const updateApiBase = (value: string) => {
    testAbortRef.current?.abort()
    testAbortRef.current = null
    setTesting(false)
    setTestState(null)
    setDraft((previous) => ({ ...previous, apiBaseUrl: value }))
    setSaveError(null)
  }

  const updateSorterBase = (value: string) => {
    setDraft((previous) => ({ ...previous, sorterApiBaseUrl: value }))
    setSaveError(null)
  }

  const discardChanges = () => {
    if (saving) return
    setDraft(draftFromSettings(settings))
    setResetPending(false)
    setSaveError(null)
    setTestState(null)
    applyAppearance(settings.appearance)
    showToast('已放弃未保存的修改', 'info')
  }

  const confirmReset = () => {
    setResetOpen(false)
    const next = draftFromSettings(DEFAULT_SETTINGS)
    next.thresholds = { ...draft.thresholds }
    setDraft(next)
    setResetPending(true)
    setSaveError(null)
    setTestState(null)
    applyAppearance(next.appearance)
    showToast('已恢复默认值，尚未保存', 'info')
  }

  const handleSave = () => {
    if (saving || !dirty || errorCount > 0 || !validation.settings) return
    const next = validation.settings
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    setSaveError(null)
    setSaving(true)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      try {
        saveSettings(next)
        setDraft(draftFromSettings(next))
        setResetPending(false)
        savedAppearanceRef.current = next.appearance
        applyAppearance(next.appearance)
        const now = new Date()
        setSavedAt(now)
        showToast(
          `已保存 ${formatClock(now)} · 仅本浏览器生效，未同步到后端或设备`,
          'success',
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : ''
        const reason = detail
          ? `浏览器存储不可用（${detail}）`
          : '浏览器存储不可用（可能处于隐私模式或空间已满）'
        setSaveError(`保存失败：${reason}，输入已保留，可重试`)
        showToast('保存失败，设置未写入', 'error')
      } finally {
        setSaving(false)
      }
    }, 220)
  }

  const runTest = async () => {
    if (testing || validation.errors.apiBaseUrl) return
    const base = normalizeApiBase(draft.apiBaseUrl)
    testAbortRef.current?.abort()
    const controller = new AbortController()
    testAbortRef.current = controller
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      controller.abort('timeout')
    }, 3000)
    setTesting(true)
    setTestState(null)
    try {
      const result = await testConnection(base, controller.signal)
      if (!mountedRef.current || controller !== testAbortRef.current) return
      setTestState({
        status: 'ok',
        base,
        elapsedMs: result.elapsedMs,
        sourceCount: result.sourceCount,
        at: Date.now(),
      })
    } catch (error) {
      if (!mountedRef.current || controller !== testAbortRef.current) return
      let message: string
      if (timedOut) {
        message = '连接超时：3 秒内无响应'
      } else if (error instanceof ApiError && error.kind === 'network') {
        message = '连接失败：无法访问主机（检查服务是否启动、IP 是否变化、防火墙是否放行 81/TCP）'
      } else {
        message = `连接失败：${errorMessage(error)}`
      }
      setTestState({ status: 'error', base, message, at: Date.now() })
    } finally {
      window.clearTimeout(timer)
      if (mountedRef.current && controller === testAbortRef.current) {
        testAbortRef.current = null
        setTesting(false)
      }
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-top">
        {dirty ? (
          <span className="settings-dirty" role="status">
            有未保存的修改
          </span>
        ) : savedAt ? (
          <span className="settings-saved" role="status">
            已保存 {formatClock(savedAt)} · 仅本浏览器生效，未同步到后端或设备
          </span>
        ) : null}
      </header>

      <fieldset className="settings-form" disabled={saving}>
        <SettingsGroup
          id="settings-appearance"
          title="外观与字号"
          description="点击选项立即在本页预览，并出现“有未保存的修改”；离开页面会恢复已保存外观。主题只更换色值，不改变业务颜色含义。"
          open={openGroups.appearance}
          onToggle={() => toggleGroup('appearance')}
        >
          <div className="settings-grid">
            <SegmentedField
              id="appearance-theme"
              label="主题"
              hint="温度、湿度与告警颜色始终按语义显示，深色下只换色值。"
            >
              <Segmented
                value={draft.appearance.theme}
                options={THEME_OPTIONS}
                onChange={(value) => updateAppearance({ theme: value })}
                ariaLabel="主题"
              />
            </SegmentedField>
            <SegmentedField
              id="appearance-font"
              label="字号"
              hint="大字号会整体放大；正文有上限，避免挤压图表与单位。"
            >
              <Segmented
                value={draft.appearance.fontScale}
                options={FONT_OPTIONS}
                onChange={(value) => updateAppearance({ fontScale: value })}
                ariaLabel="字号"
              />
            </SegmentedField>
            <SegmentedField
              id="appearance-density"
              label="密度"
              hint="宽松加大行高与卡片间距；标准让同屏显示更多行。"
            >
              <Segmented
                value={draft.appearance.density}
                options={DENSITY_OPTIONS}
                onChange={(value) => updateAppearance({ density: value })}
                ariaLabel="密度"
              />
            </SegmentedField>
          </div>
          {appearanceChanged ? (
            <p className="settings-note settings-note--warn">
              外观修改尚未保存，仅本页预览；离开页面会恢复已保存外观。
            </p>
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          id="settings-refresh"
          title="数据刷新与显示"
          description="作用于环境数据轮询与全站时间、小数显示。环境曲线读取服务端分钟历史并合并本次会话的实时分钟点；规则启用时按“规则采样间隔”加快环境数据获取。页面密度在外观组设置，不在本组重复。"
          open={openGroups.refresh}
          onToggle={() => toggleGroup('refresh')}
        >
          <div className="settings-grid">
            <SegmentedField
              id="refresh-poll"
              label="轮询间隔"
              hint="默认 5 秒；有启用规则时，实际按“规则采样间隔”和本间隔中更快的一个刷新。页面切到后台会暂停，回到前台立即刷新。"
            >
              <Segmented
                value={String(draft.refresh.pollIntervalMs)}
                options={POLL_OPTIONS}
                onChange={(value) => updateRefresh({ pollIntervalMs: Number(value) })}
                ariaLabel="轮询间隔"
              />
            </SegmentedField>

            <SegmentedField
              id="refresh-rule-poll"
              label="规则采样间隔"
              hint="仅在存在启用规则时生效，用于规则判定；最快 1 秒。间隔越短越及时，但请求也更频繁。"
            >
              <Segmented
                value={String(draft.refresh.rulePollIntervalMs)}
                options={RULE_POLL_OPTIONS}
                onChange={(value) => updateRefresh({ rulePollIntervalMs: Number(value) })}
                ariaLabel="规则采样间隔"
              />
            </SegmentedField>

            <div className="field">
              <span className="field__label">图表窗口</span>
              <div className="settings-static">固定最近 60 分钟</div>
              <span className="field__hint">
                窄屏（宽度小于 768px 或绘图区小于 560px）自动显示 30 分钟；后台按最近 60 分钟读取分钟历史，缺失分钟用前后相邻数据平均补齐。
              </span>
            </div>

            <SegmentedField
              id="refresh-seconds"
              label="显示秒"
              hint="影响采集、接收、核对与保存时间的显示；关闭后仍保存完整时间。"
            >
              <Segmented
                value={draft.refresh.showSeconds ? 'on' : 'off'}
                options={SECONDS_OPTIONS}
                onChange={(value) => updateRefresh({ showSeconds: value === 'on' })}
                ariaLabel="显示秒"
              />
            </SegmentedField>

            <SegmentedField
              id="refresh-decimals"
              label="看板读数小数位"
              hint="仅作用于看板当前温度/湿度读数；图表、设备卡、PM2.5 与光照使用各自固定精度。"
            >
              <Segmented
                value={String(draft.refresh.decimals) as '0' | '1' | '2'}
                options={DECIMALS_OPTIONS}
                onChange={(value) => updateRefresh({ decimals: Number(value) as 0 | 1 | 2 })}
                ariaLabel="小数位"
              />
            </SegmentedField>
          </div>
        </SettingsGroup>

        <SettingsGroup
          id="settings-connection"
          title="连接状态与使用说明"
          description="采集服务（环境、打卡、执行器）默认 /api，开发时转发到本机 127.0.0.1:81；分拣服务（快递记录、日志）默认 /sorter，转发到 http://192.168.1.102:82。也可把地址改成对应主机的完整局域网 URL。"
          open={openGroups.connection}
          onToggle={() => toggleGroup('connection')}
        >

          <div className="settings-field">
            <FormField label="采集服务地址" htmlFor="api-base">
              <input
                id="api-base"
                className="input"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={draft.apiBaseUrl}
                placeholder="/api 或 http://主机IP:81/api"
                aria-invalid={validation.errors.apiBaseUrl ? true : undefined}
                aria-describedby="api-base-help"
                onChange={(event) => updateApiBase(event.target.value)}
                onFocus={scrollFieldIntoView}
              />
            </FormField>
            <span
              id="api-base-help"
              role={validation.errors.apiBaseUrl ? 'alert' : undefined}
              className={
                validation.errors.apiBaseUrl
                  ? 'field__error settings-field__help'
                  : validation.warnings.apiBaseUrl
                    ? 'field__hint settings-field__help settings-note--warn'
                    : 'field__hint settings-field__help'
              }
            >
              {validation.errors.apiBaseUrl ??
                validation.warnings.apiBaseUrl ??
                '环境数据、打卡和执行器控制地址；允许 /api 同源路径或 http(s):// 完整地址，末尾 / 会自动去掉。'}
            </span>
          </div>
          {validation.errors.apiBaseUrl ? null : (
            <p className="settings-note">
              保存后生效地址：<code>{draftBase}</code>；保存会立即用新地址重新拉取数据。
            </p>
          )}

          <div className="settings-actions">
            <Button
              variant="secondary"
              onClick={() => {
                void runTest()
              }}
              loading={testing}
              disabled={Boolean(validation.errors.apiBaseUrl) || testing}
            >
              测试连接
            </Button>
            <span className="settings-note">
              GET {draftBase}/data · 超时 3 秒 · 不自动重试 · 使用当前输入但不保存
            </span>
          </div>

          {testState ? (
            <div
              className={`connection-box ${
                testState.status === 'ok' ? 'connection-box--ok' : 'connection-box--error'
              }`}
              role="status"
              aria-live="polite"
            >
              {testState.status === 'ok' ? (
                <>
                  <span className="connection-box__title">连接正常</span>
                  <span>
                    {' '}
                    · {testState.elapsedMs} ms · {testState.sourceCount} 个采集源 ·{' '}
                    {formatClock(testState.at)}
                  </span>
                  <div className="connection-box__meta">GET {testState.base}/data</div>
                  {testState.sourceCount === 0 ? (
                    <p className="settings-note settings-note--warn">
                      接口可达，但未返回 iot / multi_in_one 采集源。
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="connection-box__title">测试未通过</span>
                  <p>{testState.message}</p>
                  <div className="connection-box__meta">
                    {formatClock(testState.at)} · GET {testState.base}/data
                  </div>
                </>
              )}
            </div>
          ) : null}

          <div className="settings-field">
            <FormField label="分拣服务地址" htmlFor="sorter-api-base">
              <input
                id="sorter-api-base"
                className="input"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={draft.sorterApiBaseUrl}
                placeholder="/sorter 或 http://192.168.1.102:82"
                aria-invalid={validation.errors.sorterApiBaseUrl ? true : undefined}
                aria-describedby="sorter-api-base-help"
                onChange={(event) => updateSorterBase(event.target.value)}
                onFocus={scrollFieldIntoView}
              />
            </FormField>
            <span
              id="sorter-api-base-help"
              role={validation.errors.sorterApiBaseUrl ? 'alert' : undefined}
              className={
                validation.errors.sorterApiBaseUrl
                  ? 'field__error settings-field__help'
                  : validation.warnings.sorterApiBaseUrl
                    ? 'field__hint settings-field__help settings-note--warn'
                    : 'field__hint settings-field__help'
              }
            >
              {validation.errors.sorterApiBaseUrl ??
                validation.warnings.sorterApiBaseUrl ??
                '默认 /sorter 由开发代理或 nginx 转发到 http://192.168.1.102:82；也可直接填该完整地址。不要追加 /api。'}
            </span>
          </div>
          {validation.errors.sorterApiBaseUrl ? null : (
            <p className="settings-note">
              记录接口：<code>{draftSorterBase}/records</code> · 日志接口：<code>{draftSorterBase}/logs</code>
            </p>
          )}

          <p className="settings-conn-meta">
            当前生效采集地址：<code>{settings.apiBaseUrl}</code>，来源：本浏览器设置（用户覆盖）。
          </p>
          <p className="settings-conn-meta">
            当前生效分拣服务：<code>{settings.sorterApiBaseUrl}</code>
          </p>

          <div className="faq">
            <details>
              <summary>跨域与代理说明</summary>
              <p>
                若浏览器控制台报 CORS 错误而命令行请求正常，说明后端未允许跨域；需后端开启 CORS，或使用同源代理（Vite 开发代理 / nginx 反代 /api 并保留路径前缀）。HTTPS 页面直连 HTTP 接口会被浏览器按混合内容拦截。当前后端 CORS 配置待确认。
              </p>
            </details>
            <details>
              <summary>常见问题（6 条）</summary>
              <dl className="settings-faq-list">
                <div className="settings-faq-item">
                  <dt>平板打不开页面或一直失败？</dt>
                  <dd>
                    先在同一平板浏览器直接打开 http://192.168.1.102/api/data 验证（板子本机可用 http://127.0.0.1:81/api/data）。若失败，依次检查 nginx、81/82 服务是否运行、板子防火墙是否放行 80/81/82、平板与板子是否同一局域网且未开启 AP 隔离；平板设置里不能填 localhost 或 127.0.0.1。
                  </dd>
                </div>
                <div className="settings-faq-item">
                  <dt>多久更新一次？</dt>
                  <dd>
                    默认每 5 秒轮询一次 GET /api/data，可在“数据刷新与显示”改为 10／30／60 秒。页面切到后台会暂停，回到前台立即刷新；环境历史通过 GET /api/history/{'{metric}'} 读取最近 60 分钟记录。
                  </dd>
                </div>
                <div className="settings-faq-item">
                  <dt>曲线如何补齐缺失分钟？</dt>
                  <dd>
                    温度、湿度、光照曲线读取 GET /api/history/{'{metric}'} 的最近 60 分钟记录；如果中间某一分钟没有数据，会取前后最近两分钟的值按时间比例平均补齐。窄屏显示最近 30 分钟，页面打开期间每分钟合并新的实时分钟点。
                  </dd>
                </div>
                <div className="settings-faq-item">
                  <dt>执行器开关如何确认结果？</dt>
                  <dd>
                    采集器不提供继电器实际状态回读。开关点击后先显示目标状态，约 0.9 秒后逐路核对服务端记录；一致才保留，失败或超时自动回退并在页面上方提示，不会自动重发。服务重启后记录可能归零，仍不代表继电器的实际状态。
                  </dd>
                </div>
                <div className="settings-faq-item">
                  <dt>签到为什么没有出勤率？</dt>
                  <dd>
                    读卡器记录只返回姓名和签到时间，没有工号、班次与应到名单；运行数据页按时间倒序展示打卡记录，无法计算出勤率、迟到或缺勤。
                  </dd>
                </div>
                <div className="settings-faq-item">
                  <dt>演示地图什么时候关？</dt>
                  <dd>
                    当前没有快递统计接口，地图与合计由部署开启演示，并常驻“演示数据 · 2026-11-03 · 合计 1,205 件”。接入真实统计接口后由部署关闭演示，改为真实统计日期与数据。
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        </SettingsGroup>

        <div className="settings-reset-row">
          <Button variant="ghost" onClick={() => setResetOpen(true)}>
            恢复默认设置
          </Button>
          <span className="settings-note">
            只重置本页设置项，不清除设备展示配置，也不影响任何设备或后端数据。
          </span>
        </div>
      </fieldset>

      <div
        className="settings-savebar"
        style={savebarOffset > 0 ? { bottom: savebarOffset } : undefined}
      >
        <div className="settings-savebar__status" role="status" aria-live="polite">
          {saveError ? (
            <span className="settings-savebar__error" role="alert">
              {saveError}
            </span>
          ) : dirty ? (
            errorCount > 0 ? (
              `${errorCount} 处需要修改，保存暂不可用`
            ) : (
              '修改尚未保存，仅本页预览'
            )
          ) : savedAt ? (
            `已保存 ${formatClock(savedAt)} · 仅本浏览器生效，未同步到后端或设备`
          ) : (
            '设置仅保存在本浏览器，未同步到后端或设备'
          )}
        </div>
        <div className="settings-savebar__actions">
          <Button variant="ghost" onClick={discardChanges} disabled={!dirty || saving}>
            放弃修改
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!dirty || errorCount > 0 || saving}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      <Modal
        title="有未保存的设置"
        open={pendingPath !== null}
        onClose={() => setPendingPath(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingPath(null)}>
              留在本页
            </Button>
            <Button variant="danger" onClick={discardAndLeave}>
              放弃修改并离开
            </Button>
            <Button
              variant="primary"
              onClick={saveAndLeave}
              disabled={errorCount > 0 || !validation.settings}
            >
              保存并离开
            </Button>
          </>
        }
      >
        <p>当前设置尚未保存，离开将丢失修改。外观预览也会恢复为已保存值。</p>
        {errorCount > 0 ? (
          <p className="settings-note settings-note--warn" role="alert">
            还有 {errorCount} 处需要修改，修正后才能保存并离开；也可以放弃修改。
          </p>
        ) : (
          <p className="settings-note">保存只会写入这台平板的浏览器，不同步后端或设备。</p>
        )}
      </Modal>

      <Modal
        title="恢复默认设置？"
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmReset}>
              确认恢复
            </Button>
          </>
        }
      >
        <p>
          将把外观与字号、数据刷新与显示、采集服务地址和分拣服务地址恢复为默认值；PM2.5 与指标阈值请在“规则设置”中管理。恢复后需要再点击“保存”才会写入本浏览器。
        </p>
        <p className="settings-note">
          不会清除设备展示配置，也不会改变任何设备或后端数据；当前仍可“放弃修改”回到已保存值。
        </p>
      </Modal>
    </div>
  )
}
