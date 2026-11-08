import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, actions, className = '' }: EmptyStateProps) {
  return (
    <div className={`empty-state ${className}`.trim()}>
      {icon}
      <div className="empty-state__title">{title}</div>
      {description ? <div className="empty-state__desc">{description}</div> : null}
      {actions ? <div className="empty-state__actions">{actions}</div> : null}
    </div>
  )
}
