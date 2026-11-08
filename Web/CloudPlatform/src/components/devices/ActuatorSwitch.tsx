interface ActuatorSwitchProps {
  checked: boolean
  known: boolean
  busy?: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}

export function ActuatorSwitch({
  checked,
  known,
  busy = false,
  disabled = false,
  label,
  onChange,
}: ActuatorSwitchProps) {
  const className = [
    'actuator-switch',
    checked ? 'is-on' : 'is-off',
    known ? '' : 'is-unknown',
    busy ? 'is-busy' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      role="switch"
      aria-checked={known ? checked : false}
      aria-label={label}
      aria-busy={busy || undefined}
      className={className}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span className="actuator-switch__thumb" aria-hidden="true" />
    </button>
  )
}
