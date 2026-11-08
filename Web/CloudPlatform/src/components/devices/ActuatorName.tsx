import { useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

interface ActuatorNameProps {
  value: string
  onRename: (next: string) => void
}

const MAX_NAME_LENGTH = 16

export function ActuatorName({ value, onRename }: ActuatorNameProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const cancelledRef = useRef(false)

  const startEditing = () => {
    setDraft(value)
    cancelledRef.current = false
    setEditing(true)
  }

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      setDraft(value)
      setEditing(false)
      return
    }
    const next = draft.trim().slice(0, MAX_NAME_LENGTH)
    if (next && next !== value) onRename(next)
    setDraft(next || value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        className="actuator-name__input"
        value={draft}
        maxLength={MAX_NAME_LENGTH}
        autoFocus
        aria-label="执行器名称"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelledRef.current = true
            event.currentTarget.blur()
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="actuator-name"
      aria-label={`重命名 ${value}`}
      title="点击重命名"
      onClick={startEditing}
    >
      <span>{value}</span>
      <Pencil size={14} aria-hidden="true" />
    </button>
  )
}
