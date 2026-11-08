interface Option<T extends string> {
  value: T
  label: string
}

interface SegmentedProps<T extends string> {
  value: T
  options: Array<Option<T>>
  onChange: (value: T) => void
  ariaLabel: string
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`segmented__item${value === option.value ? ' segmented__item--active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
