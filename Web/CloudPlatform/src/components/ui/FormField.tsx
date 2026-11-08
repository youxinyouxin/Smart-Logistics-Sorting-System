import type { ReactNode } from 'react'

interface FormFieldProps {
  label: string
  htmlFor?: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
}

export function FormField({ label, htmlFor, hint, error, children }: FormFieldProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </div>
  )
}
