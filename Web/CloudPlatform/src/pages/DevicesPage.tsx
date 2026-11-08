import { useMemo, useState, type CSSProperties } from 'react'
import { AlertTriangle, Info, RefreshCw, RotateCcw, SlidersHorizontal, WifiOff } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { useDataSource } from '../lib/useDataSource'
import { useDoStatus } from '../lib/useDoStatus'
import { useSettings } from '../lib/settings'
import { getSensorMetricCards } from '../lib/sensorMetrics'
import { useToast } from '../components/ui/Toast'
import { useActuatorNames } from '../lib/actuatorNames'
import { useActuatorCommands, type ActuatorAction } from '../lib/useActuatorCommands'
import { DEVICE_LAYOUT_LIMITS, useDeviceLayout } from '../lib/deviceLayout'
import { SensorMetricCard } from '../components/devices/SensorMetricCard'
import {
  GateCard,
  SingleActuatorCard,
  ThreeColorLightCard,
  type GateState,
} from '../components/devices/ActuatorCard'
import { formatClock } from '../lib/format'
import '../styles/devices.css'

type GateCommand = Exclude<GateState, 'unknown'>

const GATE_ACTIONS: Record<GateCommand, ActuatorAction[]> = {
  open: [
    { channel: 4, value: false },
    { channel: 5, value: true },
  ],
  closed: [
    { channel: 5, value: false },
    { channel: 4, value: true },
  ],
  stopped: [
    { channel: 4, value: false },
    { channel: 5, value: false },
  ],
}

const GATE_TOAST: Record<GateCommand, { success: string; failure: string }> = {
  open: { success: '已开启', failure: '开启失败' },
  closed: { success: '已关闭', failure: '关闭失败' },
  stopped: { success: '已停止', failure: '停止失败' },
}

const TRAFFIC_LABELS: Record<number, string> = { 8: '红灯', 7: '黄灯', 6: '绿灯' }

interface LayoutSliderProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

function LayoutSlider({ id, label, value, min, max, step, onChange }: LayoutSliderProps) {
  return (
    <div className="devices-layout__field">
      <label className="devices-layout__label" htmlFor={id}>
        <span>{label}</span>
        <output className="num" htmlFor={id}>
          {value} px
        </output>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

export function DevicesPage() {
  const { snapshot, sourceState, receivedAt, error, refreshing, refresh } = useDataSource()
  const doStatus = useDoStatus(true)
  const { settings } = useSettings()
  const { showToast } = useToast()
  const { names, rename } = useActuatorNames()
  const { layout, updateLayout, resetLayout, isDefault } = useDeviceLayout()
  const [layoutOpen, setLayoutOpen] = useState(false)
  const { channelValue, isPending, execute } = useActuatorCommands({
    base: settings.apiBaseUrl,
    doMap: doStatus.doMap,
    updateChannel: doStatus.updateChannel,
    showToast,
  })
  const layoutStyle = {
    '--device-card-min-width': `${layout.width}px`,
    '--device-card-min-height': `${layout.height}px`,
    '--device-card-gap': `${layout.gap}px`,
  } as CSSProperties

  const sensorMetrics = useMemo(
    () => getSensorMetricCards(snapshot, sourceState, settings.thresholds),
    [snapshot, sourceState, settings.thresholds],
  )
  const sensorLoading = receivedAt === null && !error
  const controlsDisabled = doStatus.error !== null

  const gateState = useMemo<GateState>(() => {
    const closed = channelValue(4)
    const open = channelValue(5)
    if (closed === undefined || open === undefined) return 'unknown'
    if (open && !closed) return 'open'
    if (closed && !open) return 'closed'
    if (!open && !closed) return 'stopped'
    return 'unknown'
  }, [channelValue])

  const refreshAll = () => {
    refresh()
    doStatus.refresh()
  }

  const toggleChannel = (channel: number, name: string, next: boolean) => {
    const action = next ? '开启' : '关闭'
    void execute([{ channel, value: next }], {
      key: `DO${channel}`,
      successMessage: `${name}已${action}`,
      failureMessage: `${name}${action}失败，已恢复`,
    })
  }

  const runGateCommand = (command: GateCommand) => {
    const text = GATE_TOAST[command]
    void execute(GATE_ACTIONS[command], {
      key: 'gate',
      successMessage: `${names.gate}${text.success}`,
      failureMessage: `${names.gate}${text.failure}，已恢复`,
    })
  }

  return (
    <div className="devices-page" style={layoutStyle}>
      {error ? (
        <div className="devices-banner devices-banner--error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div className="devices-banner__body">
            <strong>
              数据连接中断{receivedAt ? `，最后成功 ${formatClock(receivedAt)}` : '，尚未成功获取数据'}
            </strong>
            <span>{error}；当前保留旧值并标记为过期，不使用演示值。</span>
          </div>
          <Button variant="secondary" small onClick={refreshAll} loading={refreshing}>
            立即刷新
          </Button>
        </div>
      ) : null}

      <div className="devices-columns">
        <section className="device-section" aria-labelledby="sensors-heading">
          <div className="device-section__head">
            <h2 className="device-section__title" id="sensors-heading">
              传感器
            </h2>
          </div>

          {sensorLoading ? (
            <div className="devices-inline-note" role="status">
              <Info size={18} aria-hidden="true" />
              <div>
                <strong>正在读取采集服务…</strong>
                <span>首次响应返回后再显示数据项状态，不会在此之前断言“未接入”。</span>
              </div>
            </div>
          ) : (
            <>
              {Object.keys(snapshot).length === 0 ? (
                <div className="devices-inline-note" role="status">
                  <WifiOff size={18} aria-hidden="true" />
                  <div>
                    <strong>后端未返回任何采集源</strong>
                    <span>9 张数据卡保留为“未接入”；请确认采集端已启动并在上传数据。</span>
                  </div>
                </div>
              ) : null}
              <div className="sensor-metric-grid">
                {sensorMetrics.map((metric) => (
                  <SensorMetricCard key={metric.key} metric={metric} />
                ))}
              </div>
            </>
          )}
        </section>

        <section className="device-section" aria-labelledby="actuators-heading">
          <div className="device-section__head">
            <h2 className="device-section__title" id="actuators-heading">
              执行器
            </h2>
          </div>

          {doStatus.error ? (
            <div className="devices-inline-note devices-inline-note--error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>无法读取执行器记录</strong>
                <span>{doStatus.error}；开关暂时不可用。</span>
              </div>
              <Button variant="secondary" small onClick={doStatus.refresh} loading={doStatus.refreshing}>
                重试
              </Button>
            </div>
          ) : null}

          {!doStatus.error && doStatus.lastUpdatedAt !== null && Object.keys(doStatus.doMap).length === 0 ? (
            <div className="devices-inline-note devices-inline-note--error" role="alert">
              <Info size={18} aria-hidden="true" />
              <div>
                <strong>后端未返回 DO 通道</strong>
                <span>开关暂时不可用。</span>
              </div>
              <Button variant="secondary" small onClick={doStatus.refresh} loading={doStatus.refreshing}>
                重试
              </Button>
            </div>
          ) : null}

          <div className="actuator-grid">
            <SingleActuatorCard
              name={names.fan}
              onRename={(next) => rename('fan', next)}
              channel={1}
              value={channelValue(1)}
              disabled={controlsDisabled}
              busy={isPending('DO1')}
              onToggle={(next) => toggleChannel(1, names.fan, next)}
            />
            <SingleActuatorCard
              name={names.light}
              onRename={(next) => rename('light', next)}
              channel={2}
              value={channelValue(2)}
              disabled={controlsDisabled}
              busy={isPending('DO2')}
              onToggle={(next) => toggleChannel(2, names.light, next)}
            />
            <SingleActuatorCard
              name={names.alarm}
              onRename={(next) => rename('alarm', next)}
              channel={3}
              value={channelValue(3)}
              disabled={controlsDisabled}
              busy={isPending('DO3')}
              onToggle={(next) => toggleChannel(3, names.alarm, next)}
            />
            <GateCard
              name={names.gate}
              onRename={(next) => rename('gate', next)}
              state={gateState}
              disabled={controlsDisabled || channelValue(4) === undefined || channelValue(5) === undefined}
              busy={isPending('gate')}
              onCommand={runGateCommand}
            />
            <ThreeColorLightCard
              name={names.traffic}
              onRename={(next) => rename('traffic', next)}
              values={{ 6: channelValue(6), 7: channelValue(7), 8: channelValue(8) }}
              disabled={controlsDisabled}
              isPending={isPending}
              onToggle={(channel, next) =>
                toggleChannel(channel, `${names.traffic}${TRAFFIC_LABELS[channel] ?? ''}`, next)
              }
            />
          </div>
        </section>
      </div>

      <div className="devices-page__actions" aria-label="页面操作">
        <Button
          variant="secondary"
          icon={<SlidersHorizontal size={18} aria-hidden="true" />}
          aria-expanded={layoutOpen}
          aria-controls="devices-layout-panel"
          onClick={() => setLayoutOpen((value) => !value)}
        >
          调整布局
        </Button>
        <Button
          variant="secondary"
          icon={<RefreshCw size={18} aria-hidden="true" />}
          loading={refreshing || doStatus.refreshing}
          onClick={refreshAll}
        >
          刷新
        </Button>
      </div>

      {layoutOpen ? (
        <section
          className="panel devices-layout devices-layout--floating"
          id="devices-layout-panel"
          aria-labelledby="devices-layout-title"
        >
          <div className="devices-layout__head">
            <h2 className="devices-layout__title" id="devices-layout-title">
              卡片布局
            </h2>
            <Button
              variant="ghost"
              icon={<RotateCcw size={17} aria-hidden="true" />}
              disabled={isDefault}
              onClick={resetLayout}
            >
              恢复默认
            </Button>
          </div>
          <div className="devices-layout__grid">
            <LayoutSlider
              id="device-card-width"
              label="卡片宽度"
              value={layout.width}
              min={DEVICE_LAYOUT_LIMITS.width.min}
              max={DEVICE_LAYOUT_LIMITS.width.max}
              step={DEVICE_LAYOUT_LIMITS.width.step}
              onChange={(width) => updateLayout({ width })}
            />
            <LayoutSlider
              id="device-card-height"
              label="卡片高度"
              value={layout.height}
              min={DEVICE_LAYOUT_LIMITS.height.min}
              max={DEVICE_LAYOUT_LIMITS.height.max}
              step={DEVICE_LAYOUT_LIMITS.height.step}
              onChange={(height) => updateLayout({ height })}
            />
            <LayoutSlider
              id="device-card-gap"
              label="卡片间距"
              value={layout.gap}
              min={DEVICE_LAYOUT_LIMITS.gap.min}
              max={DEVICE_LAYOUT_LIMITS.gap.max}
              step={DEVICE_LAYOUT_LIMITS.gap.step}
              onChange={(gap) => updateLayout({ gap })}
            />
          </div>
        </section>
      ) : null}
    </div>
  )
}
