import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { DeviceRule, RuleAlert } from '../types'
import { formatClock } from './format'
import { Modal } from '../components/ui/Overlay'
import { Button } from '../components/ui/Button'

const RULES_STORAGE_KEY = 'yx.rules.v1'

function loadRules(): DeviceRule[] {
  try {
    const raw = window.localStorage.getItem(RULES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is DeviceRule => {
      if (!item || typeof item !== 'object') return false
      const rule = item as Partial<DeviceRule>
      return (
        typeof rule.id === 'string' &&
        typeof rule.name === 'string' &&
        typeof rule.enabled === 'boolean' &&
        (rule.logic === 'and' || rule.logic === 'or') &&
        Array.isArray(rule.conditions) &&
        (rule.actionType === 'actuator' || rule.actionType === 'alert')
      )
    })
  } catch {
    return []
  }
}

export function newRuleId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

interface RulesContextValue {
  rules: DeviceRule[]
  saveRules: (rules: DeviceRule[]) => void
  addRule: (rule: DeviceRule) => void
  updateRule: (rule: DeviceRule) => void
  removeRule: (id: string) => void
  toggleRule: (id: string, enabled: boolean) => void
  pushRuleAlert: (ruleName: string, message: string) => void
}

const RulesContext = createContext<RulesContextValue | null>(null)

export function RulesProvider({ children }: { children: ReactNode }) {
  const [rules, setRules] = useState<DeviceRule[]>(loadRules)
  const [alerts, setAlerts] = useState<RuleAlert[]>([])

  const saveRules = useCallback((next: DeviceRule[]) => {
    setRules(next)
    window.localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(next))
  }, [])

  const addRule = useCallback(
    (rule: DeviceRule) => {
      saveRules([...rules, rule])
    },
    [rules, saveRules],
  )

  const updateRule = useCallback(
    (rule: DeviceRule) => {
      saveRules(rules.map((item) => (item.id === rule.id ? rule : item)))
    },
    [rules, saveRules],
  )

  const removeRule = useCallback(
    (id: string) => {
      saveRules(rules.filter((item) => item.id !== id))
    },
    [rules, saveRules],
  )

  const toggleRule = useCallback(
    (id: string, enabled: boolean) => {
      saveRules(rules.map((item) => (item.id === id ? { ...item, enabled } : item)))
    },
    [rules, saveRules],
  )

  const pushRuleAlert = useCallback((ruleName: string, message: string) => {
    setAlerts((previous) => [
      ...previous,
      { id: newRuleId(), ruleName, message, at: Date.now() },
    ])
  }, [])

  const currentAlert = alerts[0] ?? null
  const dismissAlert = () => setAlerts((previous) => previous.slice(1))

  const value = useMemo(
    () => ({ rules, saveRules, addRule, updateRule, removeRule, toggleRule, pushRuleAlert }),
    [rules, saveRules, addRule, updateRule, removeRule, toggleRule, pushRuleAlert],
  )

  return (
    <RulesContext.Provider value={value}>
      {children}
      <Modal
        title="规则触发提醒"
        open={currentAlert !== null}
        onClose={dismissAlert}
        footer={
          <Button variant="primary" onClick={dismissAlert}>
            知道了
          </Button>
        }
      >
        {currentAlert ? (
          <div className="rule-alert">
            <p className="rule-alert__name">{currentAlert.ruleName}</p>
            <p>{currentAlert.message}</p>
            <p className="settings-note">触发时间 {formatClock(currentAlert.at)} · 规则仅在本页面打开时运行</p>
            {alerts.length > 1 ? <p className="settings-note">还有 {alerts.length - 1} 条提醒待处理</p> : null}
          </div>
        ) : null}
      </Modal>
    </RulesContext.Provider>
  )
}

export function useRules(): RulesContextValue {
  const context = useContext(RulesContext)
  if (!context) throw new Error('useRules must be used inside RulesProvider')
  return context
}
