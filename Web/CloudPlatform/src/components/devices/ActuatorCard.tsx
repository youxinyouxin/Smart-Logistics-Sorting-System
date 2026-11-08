import { ActuatorName } from './ActuatorName'
import { ActuatorSwitch } from './ActuatorSwitch'

export type GateState = 'open' | 'closed' | 'stopped' | 'unknown'

interface BaseCardProps {
  name: string
  onRename: (next: string) => void
}

interface SingleActuatorCardProps extends BaseCardProps {
  channel: number
  value: boolean | undefined
  disabled: boolean
  busy: boolean
  onToggle: (next: boolean) => void
}

export function SingleActuatorCard({
  name,
  onRename,
  channel,
  value,
  disabled,
  busy,
  onToggle,
}: SingleActuatorCardProps) {
  const known = value !== undefined
  return (
    <article className="device-card actuator-card">
      <div className="actuator-card__head">
        <ActuatorName value={name} onRename={onRename} />
      </div>
      <div className="actuator-card__control">
        <ActuatorSwitch
          checked={value === true}
          known={known}
          busy={busy}
          disabled={disabled || !known}
          label={`${name}${value ? '关闭' : '开启'}`}
          onChange={onToggle}
        />
      </div>
      <div className="actuator-card__channel">继电器通道：DO{channel}</div>
    </article>
  )
}

const GATE_OPTIONS: { state: Exclude<GateState, 'unknown'>; label: string }[] = [
  { state: 'open', label: '开门' },
  { state: 'closed', label: '关门' },
  { state: 'stopped', label: '停止' },
]

interface GateCardProps extends BaseCardProps {
  state: GateState
  disabled: boolean
  busy: boolean
  onCommand: (state: Exclude<GateState, 'unknown'>) => void
}

export function GateCard({ name, onRename, state, disabled, busy, onCommand }: GateCardProps) {
  return (
    <article className="device-card actuator-card actuator-card--gate">
      <div className="actuator-card__head">
        <ActuatorName value={name} onRename={onRename} />
      </div>
      <div className="gate-control" role="group" aria-label={`${name}状态`}>
        {GATE_OPTIONS.map((option) => {
          const active = state === option.state
          return (
            <button
              key={option.state}
              type="button"
              className={`gate-btn gate-btn--${option.state}${active ? ' is-active' : ''}`}
              aria-pressed={active}
              disabled={disabled || busy}
              onClick={() => onCommand(option.state)}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <div className="actuator-card__channel">继电器通道：DO4 / DO5</div>
    </article>
  )
}

interface ThreeColorLightCardProps extends BaseCardProps {
  values: Record<number, boolean | undefined>
  disabled: boolean
  isPending: (key: string) => boolean
  onToggle: (channel: number, next: boolean) => void
}

const TRAFFIC_ROWS = [
  { label: '红灯', channel: 8 },
  { label: '黄灯', channel: 7 },
  { label: '绿灯', channel: 6 },
]

export function ThreeColorLightCard({
  name,
  onRename,
  values,
  disabled,
  isPending,
  onToggle,
}: ThreeColorLightCardProps) {
  return (
    <article className="device-card actuator-card actuator-card--traffic">
      <div className="actuator-card__head">
        <ActuatorName value={name} onRename={onRename} />
      </div>
      <div className="traffic-rows">
        {TRAFFIC_ROWS.map((row) => {
          const value = values[row.channel]
          return (
            <div className="traffic-row" key={row.channel}>
              <span className="traffic-row__label">{row.label}</span>
              <ActuatorSwitch
                checked={value === true}
                known={value !== undefined}
                busy={isPending(`DO${row.channel}`)}
                disabled={disabled || value === undefined}
                label={`${name}${row.label}${value ? '关闭' : '开启'}`}
                onChange={(next) => onToggle(row.channel, next)}
              />
            </div>
          )
        })}
      </div>
      <div className="actuator-card__channel">继电器通道：DO6–DO8</div>
    </article>
  )
}
