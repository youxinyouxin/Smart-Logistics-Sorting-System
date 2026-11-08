import { useMemo, useState } from 'react'
import { BellRing, Plus, Trash2, Workflow } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/Toast'
import { useSettings } from '../lib/settings'
import { newRuleId, useRules } from '../lib/rules'
import type {
  DeviceRule,
  RuleActionType,
  RuleCondition,
  RuleLogic,
  RuleOperator,
  RuleSensorKey,
} from '../types'
import '../styles/rules.css'

const RULE_SENSORS: Array<{ value: RuleSensorKey; label: string; unit: string }> = [
  { value: 'temperature', label: '温度', unit: '°C' },
  { value: 'humidity', label: '湿度', unit: '%RH' },
  { value: 'pm25', label: 'PM2.5', unit: 'μg/m³' },
  { value: 'co2', label: 'CO₂', unit: 'ppm' },
  { value: 'tvoc', label: 'TVOC', unit: 'ppb' },
  { value: 'illumination', label: '光照', unit: 'lx' },
  { value: 'pressure', label: '气压', unit: 'hPa' },
]

const OPERATORS: Array<{ value: RuleOperator; label: string }> = [
  { value: '>', label: '大于' },
  { value: '<', label: '小于' },
  { value: '=', label: '等于' },
]

function sensorLabel(key: RuleSensorKey): string {
  return RULE_SENSORS.find((sensor) => sensor.value === key)?.label ?? key
}

function sensorUnit(key: RuleSensorKey): string {
  return RULE_SENSORS.find((sensor) => sensor.value === key)?.unit ?? ''
}

function conditionSummary(condition: RuleCondition): string {
  const operator = OPERATORS.find((item) => item.value === condition.operator)?.label ?? condition.operator
  return `${sensorLabel(condition.sensor)} ${operator} ${condition.value} ${sensorUnit(condition.sensor)}`
}

function ruleSummary(rule: DeviceRule): string {
  const logic = rule.logic === 'and' ? '且' : '或'
  const condition = rule.conditions.map(conditionSummary).join(` ${logic} `)
  const action =
    rule.actionType === 'alert' ? '弹窗提醒' : `DO${rule.channel} ${rule.actuatorAction === 'on' ? '打开' : '关闭'}`
  return `${condition} → ${action}`
}

function newCondition(): RuleCondition {
  return { id: newRuleId(), sensor: 'temperature', operator: '>', value: '30' }
}

const DEFAULT_THRESHOLDS = {
  pm25GoodMax: '35',
  pm25MidMax: '75',
  pm25DisplayMax: '150',
  co2Max: '',
  tvocMax: '',
  lightMax: '',
}

interface ThresholdDraft {
  pm25GoodMax: string
  pm25MidMax: string
  pm25DisplayMax: string
  co2Max: string
  tvocMax: string
  lightMax: string
}

interface RuleDraft {
  name: string
  enabled: boolean
  logic: RuleLogic
  conditions: RuleCondition[]
  actionType: RuleActionType
  channel: number
  actuatorAction: 'on' | 'off'
  message: string
}

function initialRuleDraft(): RuleDraft {
  return {
    name: '',
    enabled: true,
    logic: 'and',
    conditions: [newCondition()],
    actionType: 'actuator',
    channel: 3,
    actuatorAction: 'on',
    message: '',
  }
}

export function RulesPage() {
  const { settings, saveSettings } = useSettings()
  const { rules, addRule, removeRule, toggleRule } = useRules()
  const { showToast } = useToast()

  const [thresholdDraft, setThresholdDraft] = useState<ThresholdDraft>({
    pm25GoodMax: String(settings.thresholds.pm25GoodMax),
    pm25MidMax: String(settings.thresholds.pm25MidMax),
    pm25DisplayMax: String(settings.thresholds.pm25DisplayMax),
    co2Max: settings.thresholds.co2Max === null ? '' : String(settings.thresholds.co2Max),
    tvocMax: settings.thresholds.tvocMax === null ? '' : String(settings.thresholds.tvocMax),
    lightMax: settings.thresholds.lightMax === null ? '' : String(settings.thresholds.lightMax),
  })
  const [thresholdError, setThresholdError] = useState<string | null>(null)
  const [thresholdSavedAt, setThresholdSavedAt] = useState<Date | null>(null)

  const [draft, setDraft] = useState<RuleDraft>(initialRuleDraft)
  const [ruleError, setRuleError] = useState<string | null>(null)

  const thresholdValidation = useMemo(() => {
    const good = Number(thresholdDraft.pm25GoodMax)
    const mid = Number(thresholdDraft.pm25MidMax)
    const display = Number(thresholdDraft.pm25DisplayMax)
    const co2 = thresholdDraft.co2Max === '' ? null : Number(thresholdDraft.co2Max)
    const tvoc = thresholdDraft.tvocMax === '' ? null : Number(thresholdDraft.tvocMax)
    const light = thresholdDraft.lightMax === '' ? null : Number(thresholdDraft.lightMax)
    if (!Number.isInteger(good) || good < 1 || good > 499) return { error: 'PM2.5 优上限需在 1–499 之间' }
    if (!Number.isInteger(mid) || mid < 2 || mid > 500) return { error: 'PM2.5 良上限需在 2–500 之间' }
    if (good >= mid) return { error: 'PM2.5 优上限必须小于良上限' }
    if (!Number.isInteger(display) || display < 50 || display > 500) return { error: '显示量程需在 50–500 之间' }
    if (display < mid) return { error: '显示量程不能低于 PM2.5 良上限' }
    if (co2 !== null && (!Number.isInteger(co2) || co2 < 400 || co2 > 5000)) return { error: 'CO₂ 上限需在 400–5000 ppm 之间' }
    if (tvoc !== null && (!Number.isInteger(tvoc) || tvoc < 0 || tvoc > 10000)) return { error: 'TVOC 上限需在 0–10000 ppb 之间' }
    if (light !== null && (!Number.isInteger(light) || light < 1 || light > 5000)) return { error: '光照上限需在 1–5000 lx 之间' }
    return { error: null, values: { pm25GoodMax: good, pm25MidMax: mid, pm25DisplayMax: display, co2Max: co2, tvocMax: tvoc, lightMax: light } }
  }, [thresholdDraft])

  const saveThresholds = () => {
    if (thresholdValidation.error || !thresholdValidation.values) {
      setThresholdError(thresholdValidation.error)
      return
    }
    setThresholdError(null)
    saveSettings({
      ...settings,
      thresholds: {
        ...settings.thresholds,
        ...thresholdValidation.values,
      },
    })
    setThresholdSavedAt(new Date())
    showToast('PM2.5 与指标阈值已保存 · 仅本浏览器生效', 'success')
  }

  const resetThresholds = () => {
    setThresholdDraft({ ...DEFAULT_THRESHOLDS })
    setThresholdError(null)
    setThresholdSavedAt(null)
  }

  const updateCondition = (id: string, patch: Partial<RuleCondition>) => {
    setDraft((previous) => ({
      ...previous,
      conditions: previous.conditions.map((condition) =>
        condition.id === id ? { ...condition, ...patch } : condition,
      ),
    }))
    setRuleError(null)
  }

  const addCondition = () => {
    setDraft((previous) => ({
      ...previous,
      conditions: previous.conditions.length >= 4 ? previous.conditions : [...previous.conditions, newCondition()],
    }))
  }

  const removeCondition = (id: string) => {
    setDraft((previous) => ({
      ...previous,
      conditions: previous.conditions.length <= 1 ? previous.conditions : previous.conditions.filter((item) => item.id !== id),
    }))
  }

  const saveRule = () => {
    if (draft.conditions.length === 0) {
      setRuleError('至少需要一条条件')
      return
    }
    for (const condition of draft.conditions) {
      const value = Number(condition.value)
      if (!Number.isFinite(value)) {
        setRuleError('条件值必须是数字')
        return
      }
    }
    if (draft.actionType === 'alert' && draft.message.trim() === '') {
      setRuleError('弹窗提醒需要填写提醒内容')
      return
    }
    const name = draft.name.trim() || `规则 ${rules.length + 1}`
    addRule({
      id: newRuleId(),
      name,
      enabled: draft.enabled,
      logic: draft.logic,
      conditions: draft.conditions.map((condition) => ({ ...condition, value: String(Number(condition.value)) })),
      actionType: draft.actionType,
      channel: draft.channel,
      actuatorAction: draft.actuatorAction,
      message: draft.message.trim(),
    })
    setDraft(initialRuleDraft())
    setRuleError(null)
    showToast(`已添加规则「${name}」· 仅本浏览器生效`, 'success')
  }

  return (
    <div className="rules-page">
      <section className="panel rules-panel" aria-labelledby="rules-threshold-title">
        <div className="rules-panel__head">
          <div>
            <h2 className="panel__title" id="rules-threshold-title">
              PM2.5 与指标阈值
            </h2>
            <p className="settings-group__desc">仅影响网页显示、状态与提醒，不直接控制设备；阈值只保存在本浏览器。</p>
          </div>
        </div>

        <div className="rules-threshold-grid">
          <label className="field">
            <span className="field__label">PM2.5 优上限 <small>μg/m³</small></span>
            <input className="input" type="number" min={1} max={499} value={thresholdDraft.pm25GoodMax} onChange={(event) => setThresholdDraft({ ...thresholdDraft, pm25GoodMax: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">PM2.5 良上限 <small>μg/m³</small></span>
            <input className="input" type="number" min={2} max={500} value={thresholdDraft.pm25MidMax} onChange={(event) => setThresholdDraft({ ...thresholdDraft, pm25MidMax: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">显示量程 <small>μg/m³</small></span>
            <input className="input" type="number" min={50} max={500} value={thresholdDraft.pm25DisplayMax} onChange={(event) => setThresholdDraft({ ...thresholdDraft, pm25DisplayMax: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">CO₂ 上限 <small>ppm</small></span>
            <input className="input" type="number" min={400} max={5000} placeholder="未设" value={thresholdDraft.co2Max} onChange={(event) => setThresholdDraft({ ...thresholdDraft, co2Max: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">TVOC 上限 <small>ppb</small></span>
            <input className="input" type="number" min={0} max={10000} placeholder="未设" value={thresholdDraft.tvocMax} onChange={(event) => setThresholdDraft({ ...thresholdDraft, tvocMax: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">光照上限 <small>lx</small></span>
            <input className="input" type="number" min={1} max={5000} placeholder="未设" value={thresholdDraft.lightMax} onChange={(event) => setThresholdDraft({ ...thresholdDraft, lightMax: event.target.value })} />
          </label>
        </div>
        <p className="settings-note">PM2.5 35/75 为项目自定义显示分级，量程不是健康标准；其他指标上限留空表示不提醒。本部署已关闭服务端环境联动，执行器动作由下方规则在本页触发。</p>
        {thresholdError ? <div className="field__error" role="alert">{thresholdError}</div> : null}
        <div className="rules-actions">
          <Button variant="secondary" onClick={resetThresholds}>
            恢复默认值
          </Button>
          <Button variant="primary" onClick={saveThresholds}>
            保存阈值
          </Button>
          {thresholdSavedAt ? <span className="settings-note">已保存 {thresholdSavedAt.toLocaleTimeString('zh-CN', { hour12: false })}</span> : null}
        </div>
      </section>

      <section className="panel rules-panel" aria-labelledby="rules-builder-title">
        <div className="rules-panel__head">
          <div>
            <h2 className="panel__title" id="rules-builder-title">
              设备联动规则
            </h2>
            <p className="settings-group__desc">
              规则只保存在本浏览器，页面打开时按采集数据评估；条件从“不满足”变为“满足”时触发一次，避免重复下发。
            </p>
          </div>
          <Workflow size={22} aria-hidden="true" />
        </div>

        <div className="rule-builder">
          <div className="rules-grid">
            <label className="field">
              <span className="field__label">规则名称</span>
              <input className="input" value={draft.name} placeholder={`规则 ${rules.length + 1}`} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="field rules-check">
              <span className="field__label">启用这条规则</span>
              <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            </label>
          </div>

          <div className="rule-conditions">
            {draft.conditions.map((condition, index) => (
              <div className="rule-condition" key={condition.id}>
                <span className="rule-condition__index">条件 {index + 1}</span>
                <select className="select" value={condition.sensor} onChange={(event) => updateCondition(condition.id, { sensor: event.target.value as RuleSensorKey })} aria-label={`条件 ${index + 1} 传感器`}>
                  {RULE_SENSORS.map((sensor) => (
                    <option key={sensor.value} value={sensor.value}>{sensor.label}</option>
                  ))}
                </select>
                <select className="select" value={condition.operator} onChange={(event) => updateCondition(condition.id, { operator: event.target.value as RuleOperator })} aria-label={`条件 ${index + 1} 比较`}>
                  {OPERATORS.map((operator) => (
                    <option key={operator.value} value={operator.value}>{operator.label}</option>
                  ))}
                </select>
                <input className="input" type="number" step="any" value={condition.value} onChange={(event) => updateCondition(condition.id, { value: event.target.value })} aria-label={`条件 ${index + 1} 数值`} />
                <span className="rule-condition__unit">{sensorUnit(condition.sensor)}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`删除条件 ${index + 1}`}
                  disabled={draft.conditions.length <= 1}
                  onClick={() => removeCondition(condition.id)}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
          <div className="rules-actions rules-actions--left">
            <Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={addCondition} disabled={draft.conditions.length >= 4}>
              添加条件
            </Button>
            {draft.conditions.length > 1 ? (
              <label className="rules-inline-select">
                <span>条件之间</span>
                <select className="select" value={draft.logic} onChange={(event) => setDraft({ ...draft, logic: event.target.value as RuleLogic })}>
                  <option value="and">同时满足（与）</option>
                  <option value="or">任一满足（或）</option>
                </select>
              </label>
            ) : null}
          </div>

          <div className="rules-grid">
            <label className="field">
              <span className="field__label">执行动作</span>
              <select className="select" value={draft.actionType} onChange={(event) => setDraft({ ...draft, actionType: event.target.value as RuleActionType })}>
                <option value="actuator">执行器</option>
                <option value="alert">弹窗提醒</option>
              </select>
            </label>
            {draft.actionType === 'actuator' ? (
              <>
                <label className="field">
                  <span className="field__label">执行器通道</span>
                  <select className="select" value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: Number(event.target.value) })}>
                    {Array.from({ length: 8 }, (_, index) => index + 1).map((channel) => (
                      <option key={channel} value={channel}>DO{channel}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">动作</span>
                  <select className="select" value={draft.actuatorAction} onChange={(event) => setDraft({ ...draft, actuatorAction: event.target.value as 'on' | 'off' })}>
                    <option value="on">打开</option>
                    <option value="off">关闭</option>
                  </select>
                </label>
              </>
            ) : (
              <label className="field rules-message">
                <span className="field__label">提醒内容</span>
                <input className="input" value={draft.message} placeholder="例如：温度过高，请检查车间通风" onChange={(event) => setDraft({ ...draft, message: event.target.value })} />
              </label>
            )}
          </div>

          {ruleError ? <div className="field__error" role="alert">{ruleError}</div> : null}
          <div className="rules-actions">
            <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={saveRule}>
              添加规则
            </Button>
          </div>
          <p className="settings-note">
            规则按边沿触发：条件从未满足变为满足时只执行一次，持续满足不会重复下发；只有条件恢复为不满足后再次满足才会重新触发。传感器数据缺失或过期时暂停判定并保留上一状态。新建或重新启用规则时以当前状态为起点，不补触发。规则仅在本网页打开时运行，判定频率由设置中心的“规则采样间隔”控制（1–5 秒，最快 1 秒）。
          </p>
          <p className="settings-note">
            执行器动作只记录服务端下发结果，读不到硬件实际状态；执行前不弹二次确认。
          </p>
        </div>

        <div className="rule-list">
          <div className="rules-list-head">
            <span>已添加规则</span>
            <span>{rules.length} 条</span>
          </div>
          {rules.length === 0 ? (
            <p className="rules-empty">还没有规则。设置条件与动作后点击“添加规则”。</p>
          ) : (
            rules.map((rule) => (
              <article className={`rule-card${rule.enabled ? '' : ' rule-card--disabled'}`} key={rule.id}>
                <div className="rule-card__head">
                  <div>
                    <div className="rule-card__name">
                      {rule.actionType === 'alert' ? <BellRing size={16} aria-hidden="true" /> : <Workflow size={16} aria-hidden="true" />}
                      {rule.name}
                    </div>
                    <div className="rule-card__summary">{ruleSummary(rule)}</div>
                  </div>
                  <label className="rule-switch">
                    <input type="checkbox" checked={rule.enabled} onChange={(event) => toggleRule(rule.id, event.target.checked)} />
                    <span>{rule.enabled ? '已启用' : '已停用'}</span>
                  </label>
                  <Button variant="ghost" small onClick={() => removeRule(rule.id)}>
                    <Trash2 size={16} aria-hidden="true" />
                    删除
                  </Button>
                </div>
                {rule.actionType === 'alert' && rule.message ? <p className="rule-card__message">提醒：{rule.message}</p> : null}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
