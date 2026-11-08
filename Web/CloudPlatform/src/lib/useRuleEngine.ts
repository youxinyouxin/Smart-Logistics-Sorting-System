import { useEffect, useRef } from 'react'
import type { DeviceRule, RuleSensorKey } from '../types'
import { useDataSource } from './useDataSource'
import { useRules } from './rules'
import { useSettings } from './settings'
import { useToast } from '../components/ui/Toast'
import { getSensorMetricCards } from './sensorMetrics'
import { errorMessage, setDoChannel } from './api'

interface RuleRuntime {
  active: boolean
  initialized: boolean
  enabled: boolean
  signature: string
}

function ruleSignature(rule: DeviceRule): string {
  return `${rule.logic}|${rule.conditions
    .map((condition) => `${condition.sensor}:${condition.operator}:${condition.value}`)
    .join(',')}`
}

function evaluateRule(rule: DeviceRule, values: Partial<Record<RuleSensorKey, number>>): boolean | null {
  if (rule.conditions.length === 0) return false
  if (
    rule.conditions.some((condition) => {
      const value = values[condition.sensor]
      return value === undefined || !Number.isFinite(Number(condition.value))
    })
  ) {
    return null
  }
  const results = rule.conditions.map((condition) => {
    const value = values[condition.sensor] as number
    const target = Number(condition.value)
    switch (condition.operator) {
      case '>':
        return value > target
      case '<':
        return value < target
      case '=':
        return value === target
      default:
        return false
    }
  })
  return rule.logic === 'and' ? results.every(Boolean) : results.some(Boolean)
}

export function useRuleEngine(): void {
  const { snapshot, sourceState } = useDataSource()
  const { rules, pushRuleAlert } = useRules()
  const { settings } = useSettings()
  const { showToast } = useToast()
  const runtimeRef = useRef<Record<string, RuleRuntime>>({})

  useEffect(() => {
    const metrics = getSensorMetricCards(snapshot, sourceState, settings.thresholds)
    const values: Partial<Record<RuleSensorKey, number>> = {}
    for (const metric of metrics) {
      if (typeof metric.value !== 'number') continue
      if (metric.status === 'expired' || metric.status === 'missing' || metric.status === 'invalid' || metric.status === 'unavailable') {
        continue
      }
      values[metric.key as RuleSensorKey] = metric.value
    }

    const ruleIds = new Set(rules.map((rule) => rule.id))
    for (const id of Object.keys(runtimeRef.current)) {
      if (!ruleIds.has(id)) delete runtimeRef.current[id]
    }

    for (const rule of rules) {
      const signature = ruleSignature(rule)
      const previous = runtimeRef.current[rule.id]

      if (!rule.enabled) {
        runtimeRef.current[rule.id] = {
          active: previous?.active ?? false,
          initialized: previous?.initialized ?? false,
          enabled: false,
          signature,
        }
        continue
      }

      const active = evaluateRule(rule, values)

      // 新建、重新启用或修改条件时，以当前状态作为起点，不补触发。
      if (!previous || !previous.enabled || previous.signature !== signature) {
        runtimeRef.current[rule.id] = {
          active: active ?? false,
          initialized: active !== null,
          enabled: true,
          signature,
        }
        continue
      }

      // 传感器数据缺失时暂停判定并保留上一状态，避免断数后重新触发。
      if (active === null) {
        runtimeRef.current[rule.id] = { ...previous, enabled: true, signature }
        continue
      }

      if (!previous.initialized) {
        runtimeRef.current[rule.id] = { active, initialized: true, enabled: true, signature }
        continue
      }

      runtimeRef.current[rule.id] = { active, initialized: true, enabled: true, signature }
      if (!active || previous.active) continue

      if (rule.actionType === 'alert') {
        pushRuleAlert(rule.name || '未命名规则', rule.message || '规则条件已满足，请查看现场。')
        continue
      }

      if (rule.channel < 1 || rule.channel > 8) continue
      const value = rule.actuatorAction === 'on'
      void setDoChannel(settings.apiBaseUrl, rule.channel, value)
        .then(() => {
          showToast(
            `规则「${rule.name || '未命名规则'}」已下发：DO${rule.channel} ${value ? '打开' : '关闭'}（服务端记录）`,
            'success',
          )
        })
        .catch((error) => {
          showToast(`规则「${rule.name || '未命名规则'}」下发失败：${errorMessage(error)}`, 'error')
        })
    }
  }, [
    snapshot,
    sourceState,
    rules,
    settings.apiBaseUrl,
    settings.thresholds,
    pushRuleAlert,
    showToast,
  ])
}
